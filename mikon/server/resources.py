from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import psutil

from mikon.server.models import (
    Diagnostics,
    FrameworkCheck,
    GpuInfo,
    GpuProcess,
    MachineInfo,
    ResourceSnapshot,
)
from mikon.server.settings import Settings
from mikon.server.store import Store


class ResourceMonitor:
    def __init__(self, settings: Settings, store: Store | None = None) -> None:
        self.settings = settings
        self.store = store

    def snapshot(self) -> ResourceSnapshot:
        pid_run_map = self.store.pid_run_map() if self.store is not None else {}
        gpus: list[GpuInfo] = []
        for backend in _available_backends(self.settings):
            try:
                gpus.extend(backend.gpus(pid_run_map))
            except Exception:
                continue
        return ResourceSnapshot(
            t=datetime.now(UTC),
            gpus=gpus,
            machine=_machine_info(self.settings.project_root),
            gpu_available=bool(gpus),
        )

    def diagnostics(self) -> Diagnostics:
        snapshot = self.snapshot()
        vendors = sorted({gpu.vendor for gpu in snapshot.gpus})
        frameworks = _framework_checks(vendors)
        return Diagnostics(
            gpu_vendors=vendors, frameworks=frameworks, ok=all(not item.warning for item in frameworks)
        )


class GpuBackend:
    vendor: Literal["nvidia", "amd"]
    visible_env: str

    def gpus(self, pid_run_map: dict[int, str]) -> list[GpuInfo]:
        raise NotImplementedError


class NvidiaBackend(GpuBackend):
    vendor: Literal["nvidia"] = "nvidia"
    visible_env = "CUDA_VISIBLE_DEVICES"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @classmethod
    def available(cls) -> bool:
        try:
            import pynvml

            pynvml.nvmlInit()
            pynvml.nvmlShutdown()
            return True
        except Exception:
            return shutil.which("nvidia-smi") is not None

    def gpus(self, pid_run_map: dict[int, str]) -> list[GpuInfo]:
        try:
            return self._nvml_gpus(pid_run_map)
        except Exception:
            return self._nvidia_smi_gpus(pid_run_map)

    def _nvml_gpus(self, pid_run_map: dict[int, str]) -> list[GpuInfo]:
        import pynvml

        pynvml.nvmlInit()
        try:
            result: list[GpuInfo] = []
            count = pynvml.nvmlDeviceGetCount()
            for index in range(count):
                handle = pynvml.nvmlDeviceGetHandleByIndex(index)
                name = pynvml.nvmlDeviceGetName(handle)
                if isinstance(name, bytes):
                    name = name.decode("utf-8", errors="replace")
                util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
                processes = _nvml_processes(handle, pid_run_map)
                mem_used = int(memory.used / 1024 / 1024)
                util_pct = float(util.gpu)
                result.append(
                    GpuInfo(
                        id=f"nvidia:{index}",
                        vendor="nvidia",
                        index=index,
                        name=str(name),
                        util_pct=util_pct,
                        mem_used_mib=mem_used,
                        mem_total_mib=int(memory.total / 1024 / 1024),
                        temp_c=_nvml_temperature(pynvml, handle),
                        power_w=_nvml_power(pynvml, handle),
                        occupied=_occupied(mem_used, util_pct, self.settings),
                        processes=processes,
                    )
                )
            return result
        finally:
            pynvml.nvmlShutdown()

    def _nvidia_smi_gpus(self, pid_run_map: dict[int, str]) -> list[GpuInfo]:
        query = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
        command = [
            "nvidia-smi",
            f"--query-gpu={query}",
            "--format=csv,noheader,nounits",
        ]
        completed = subprocess.run(command, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if completed.returncode != 0:
            return []
        result: list[GpuInfo] = []
        for line in completed.stdout.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 7:
                continue
            index = int(parts[0])
            util_pct = _float_or_zero(parts[2])
            mem_used = int(_float_or_zero(parts[3]))
            result.append(
                GpuInfo(
                    id=f"nvidia:{index}",
                    vendor="nvidia",
                    index=index,
                    name=parts[1],
                    util_pct=util_pct,
                    mem_used_mib=mem_used,
                    mem_total_mib=int(_float_or_zero(parts[4])),
                    temp_c=_float_or_none(parts[5]),
                    power_w=_float_or_none(parts[6]),
                    occupied=_occupied(mem_used, util_pct, self.settings),
                    processes=[],
                )
            )
        return result


class AmdBackend(GpuBackend):
    vendor: Literal["amd"] = "amd"
    visible_env = "ROCR_VISIBLE_DEVICES"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @classmethod
    def available(cls) -> bool:
        try:
            import amdsmi  # noqa: F401

            return True
        except Exception:
            pass
        for cmd, extra in [("rocm-smi", ["--json"]), ("amd-smi", ["list", "--json"])]:
            path = shutil.which(cmd)
            if path:
                try:
                    probe = subprocess.run(
                        [path] + extra,
                        capture_output=True,
                        text=True,
                        timeout=5,
                        check=False,
                    )
                    # rocm-smi returns 0 even when amdgpu module is absent;
                    # treat as unavailable if stderr mentions driver/init errors.
                    bad = probe.returncode != 0 or any(
                        phrase in probe.stderr.lower()
                        for phrase in ("not initialized", "driver not", "amdgpu not found")
                    )
                    if not bad:
                        return True
                except Exception:
                    pass
        return False

    def gpus(self, pid_run_map: dict[int, str]) -> list[GpuInfo]:
        try:
            return self._amdsmi_gpus(pid_run_map)
        except Exception:
            pass
        command_name = shutil.which("rocm-smi") or shutil.which("amd-smi")
        if command_name is None:
            return []
        completed = subprocess.run(
            [command_name, "--showuse", "--showmemuse", "--showtemp", "--showpower", "--json"],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if completed.returncode != 0:
            return []
        try:
            data = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return []
        result: list[GpuInfo] = []
        for index, (_key, value) in enumerate(sorted(data.items())):
            if not isinstance(value, dict):
                continue
            util_pct = _first_number(value, ["GPU use (%)", "GPU use", "GPU Use (%)"])
            mem_pct = _first_number(value, ["GPU Memory Allocated (VRAM%)", "GPU memory use (%)"])
            temp_c = _first_number(value, ["Temperature (Sensor edge) (C)", "Temperature (C)"])
            power_w = _first_number(value, ["Average Graphics Package Power (W)", "Current Socket Graphics Package Power (W)"])
            mem_total = 0
            mem_used = 0
            if mem_pct is not None:
                util_mem = max(0.0, float(mem_pct))
                mem_total = 100
                mem_used = int(util_mem)
            result.append(
                GpuInfo(
                    id=f"amd:{index}",
                    vendor="amd",
                    index=index,
                    name=str(value.get("Card series") or value.get("GPU ID") or f"AMD GPU {index}"),
                    util_pct=float(util_pct or 0),
                    mem_used_mib=mem_used,
                    mem_total_mib=mem_total,
                    temp_c=temp_c,
                    power_w=power_w,
                    occupied=_occupied(mem_used, float(util_pct or 0), self.settings),
                    processes=_amd_cli_processes(pid_run_map, index),
                )
            )
        return result

    def _amdsmi_gpus(self, pid_run_map: dict[int, str]) -> list[GpuInfo]:
        import amdsmi

        amdsmi.amdsmi_init()
        try:
            handles = list(amdsmi.amdsmi_get_processor_handles())
            result: list[GpuInfo] = []
            for index, handle in enumerate(handles):
                info = _dict_or_empty(_safe_call(amdsmi, "amdsmi_get_gpu_asic_info", handle))
                activity = _dict_or_empty(_safe_call(amdsmi, "amdsmi_get_gpu_activity", handle))
                memory = _dict_or_empty(_safe_call(amdsmi, "amdsmi_get_gpu_vram_usage", handle))
                util_pct = _first_number(activity, ["gfx_activity", "gpu_activity", "GPU use (%)", "GPU use"])
                mem_used = int(_first_number(memory, ["vram_used", "used", "used_memory"]) or 0)
                mem_total = int(_first_number(memory, ["vram_total", "total", "total_memory"]) or 0)
                if mem_used > 1024 * 1024:
                    mem_used = int(mem_used / 1024 / 1024)
                if mem_total > 1024 * 1024:
                    mem_total = int(mem_total / 1024 / 1024)
                result.append(
                    GpuInfo(
                        id=f"amd:{index}",
                        vendor="amd",
                        index=index,
                        name=str(info.get("market_name") or info.get("product_name") or info.get("asic_name") or f"AMD GPU {index}"),
                        util_pct=float(util_pct or 0),
                        mem_used_mib=mem_used,
                        mem_total_mib=mem_total,
                        temp_c=_float_or_none(_safe_call(amdsmi, "amdsmi_get_temp_metric", handle, 0, 0)),
                        power_w=_float_or_none(_safe_call(amdsmi, "amdsmi_get_power_info", handle)),
                        occupied=_occupied(mem_used, float(util_pct or 0), self.settings),
                        processes=_amdsmi_processes(amdsmi, handle, pid_run_map),
                    )
                )
            return result
        finally:
            try:
                amdsmi.amdsmi_shut_down()
            except Exception:
                pass


class ClinfoBackend(GpuBackend):
    """AMD GPU fallback for environments where the amdgpu kernel module is
    absent (WSL2, certain container setups) but OpenCL is functional.
    Reports static info only — utilisation and memory usage are unavailable."""

    vendor: Literal["amd"] = "amd"
    visible_env = "ROCR_VISIBLE_DEVICES"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @classmethod
    def available(cls) -> bool:
        if shutil.which("clinfo") is None:
            return False
        try:
            result = subprocess.run(
                ["clinfo"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            return "1002h" in result.stdout
        except Exception:
            return False

    def gpus(self, pid_run_map: dict[int, str]) -> list[GpuInfo]:
        try:
            result = subprocess.run(
                ["clinfo"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if result.returncode != 0:
                return []
            return self._parse(result.stdout)
        except Exception:
            return []

    def _parse(self, text: str) -> list[GpuInfo]:
        result: list[GpuInfo] = []
        gpu_index = 0
        current: dict[str, str] = {}
        in_device = False

        for raw_line in text.splitlines():
            line = raw_line.strip()
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip()

            if key == "Device Type":
                if in_device:
                    gpu = self._make_gpu(current, gpu_index)
                    if gpu is not None:
                        result.append(gpu)
                        gpu_index += 1
                current = {"device_type": value}
                in_device = True
            elif in_device:
                if key == "Vendor ID":
                    current["vendor_id"] = value
                elif key == "Board name":
                    current["board_name"] = value
                elif key == "Name" and "board_name" not in current:
                    current["name"] = value
                elif key == "Global memory size":
                    current["global_mem"] = value

        if in_device:
            gpu = self._make_gpu(current, gpu_index)
            if gpu is not None:
                result.append(gpu)

        return result

    def _make_gpu(self, info: dict[str, str], index: int) -> GpuInfo | None:
        if "GPU" not in info.get("device_type", ""):
            return None
        if "1002" not in info.get("vendor_id", "").lower():
            return None
        name = info.get("board_name") or info.get("name") or f"AMD GPU {index}"
        mem_total_mib = 0
        mem_bytes = _float_or_none(info.get("global_mem", ""))
        if mem_bytes:
            mem_total_mib = int(mem_bytes / 1024 / 1024)
        return GpuInfo(
            id=f"amd:{index}",
            vendor="amd",
            index=index,
            name=name,
            util_pct=0.0,
            mem_used_mib=0,
            mem_total_mib=mem_total_mib,
            temp_c=None,
            power_w=None,
            occupied=False,
            processes=[],
        )


def visible_env_for_vendor(vendor: str) -> str:
    if vendor == "nvidia":
        return NvidiaBackend.visible_env
    if vendor == "amd":
        return AmdBackend.visible_env
    raise ValueError(f"unknown GPU vendor: {vendor}")


def _available_backends(settings: Settings) -> list[GpuBackend]:
    backends: list[GpuBackend] = []
    if NvidiaBackend.available():
        backends.append(NvidiaBackend(settings))
    if AmdBackend.available():
        backends.append(AmdBackend(settings))
    elif ClinfoBackend.available():
        backends.append(ClinfoBackend(settings))
    return backends


def _machine_info(project_root: Path) -> MachineInfo:
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage(project_root)
    return MachineInfo(
        cpu_pct=float(psutil.cpu_percent(interval=None)),
        cpu_count=psutil.cpu_count() or 0,
        mem_used_mib=int((mem.total - mem.available) / 1024 / 1024),
        mem_total_mib=int(mem.total / 1024 / 1024),
        disk_used_gb=round(disk.used / 1024 / 1024 / 1024, 2),
        disk_total_gb=round(disk.total / 1024 / 1024 / 1024, 2),
    )


def _nvml_processes(handle: Any, pid_run_map: dict[int, str]) -> list[GpuProcess]:
    import pynvml

    result: list[GpuProcess] = []
    try:
        processes = pynvml.nvmlDeviceGetComputeRunningProcesses(handle)
    except Exception:
        processes = []
    for process in processes:
        pid = int(process.pid)
        used_mib = int((getattr(process, "usedGpuMemory", 0) or 0) / 1024 / 1024)
        run_id = pid_run_map.get(pid)
        user = None
        name = None
        try:
            ps_process = psutil.Process(pid)
            user = ps_process.username()
            name = ps_process.name()
        except psutil.Error:
            pass
        result.append(
            GpuProcess(
                pid=pid,
                user=user,
                name=name,
                used_mib=used_mib,
                owned_by_mikon=run_id is not None,
                run_id=run_id,
            )
        )
    return result


def _amdsmi_processes(amdsmi: Any, handle: Any, pid_run_map: dict[int, str]) -> list[GpuProcess]:
    raw = _safe_call(amdsmi, "amdsmi_get_gpu_process_list", handle)
    if raw is None:
        return []
    result: list[GpuProcess] = []
    for item in _iter_process_records(raw):
        process = _gpu_process_from_raw(item, pid_run_map)
        if process is not None:
            result.append(process)
    return result


def _amd_cli_processes(pid_run_map: dict[int, str], gpu_index: int) -> list[GpuProcess]:
    command = shutil.which("amd-smi")
    if command:
        completed = subprocess.run([command, "process", "--json"], check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if completed.returncode == 0:
            processes = _parse_amd_process_json(completed.stdout, pid_run_map, gpu_index)
            if processes:
                return processes
    command = shutil.which("rocm-smi")
    if command:
        completed = subprocess.run([command, "--showpidgpus", "--json"], check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if completed.returncode == 0:
            return _parse_amd_process_json(completed.stdout, pid_run_map, gpu_index)
    return []


def _parse_amd_process_json(text: str, pid_run_map: dict[int, str], gpu_index: int) -> list[GpuProcess]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    result: list[GpuProcess] = []

    def walk(value: Any, current_gpu: int | None = None) -> None:
        if isinstance(value, dict):
            next_gpu = current_gpu
            for key in ("gpu", "GPU", "gpu_id", "gpu_index", "device", "card"):
                if key in value:
                    parsed = _int_or_none(value[key])
                    if parsed is not None:
                        next_gpu = parsed
                        break
            process = _gpu_process_from_raw(value, pid_run_map)
            if process is not None and (next_gpu is None or next_gpu == gpu_index):
                result.append(process)
            for key, item in value.items():
                inferred_gpu = next_gpu
                match = re.search(r"(\d+)", str(key))
                if match and str(key).lower().startswith(("gpu", "card")):
                    inferred_gpu = int(match.group(1))
                walk(item, inferred_gpu)
        elif isinstance(value, list):
            for item in value:
                walk(item, current_gpu)

    walk(data)
    unique: dict[int, GpuProcess] = {}
    for process in result:
        unique[process.pid] = process
    return list(unique.values())


def _gpu_process_from_raw(raw: Any, pid_run_map: dict[int, str]) -> GpuProcess | None:
    if not isinstance(raw, dict):
        return None
    pid = None
    for key in ("pid", "PID", "process_id", "processId"):
        if key in raw:
            pid = _int_or_none(raw[key])
            break
    if pid is None:
        return None
    used_mib = _process_used_mib(raw)
    run_id = pid_run_map.get(pid)
    user = raw.get("user") or raw.get("USER")
    name = raw.get("name") or raw.get("process_name") or raw.get("command") or raw.get("NAME")
    if user is None or name is None:
        try:
            ps_process = psutil.Process(pid)
            user = user or ps_process.username()
            name = name or ps_process.name()
        except psutil.Error:
            pass
    return GpuProcess(
        pid=pid,
        user=str(user) if user is not None else None,
        name=str(name) if name is not None else None,
        used_mib=used_mib,
        owned_by_mikon=run_id is not None,
        run_id=run_id,
    )


def _iter_process_records(raw: Any) -> list[Any]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("processes", "process_list", "PROCESS_INFO", "gpu_process_list"):
            value = raw.get(key)
            if isinstance(value, list):
                return value
        return [raw]
    return []


def _process_used_mib(raw: dict[str, Any]) -> int:
    for key in ("used_mib", "used_memory", "memory_usage", "VRAM_MEM", "vram_mem", "MEM_USAGE"):
        if key in raw:
            value = raw[key]
            if isinstance(value, dict):
                nested = _process_used_mib(value)
                if nested:
                    return nested
            parsed = _float_or_none(value)
            if parsed is not None:
                text = str(value).lower()
                if "gb" in text:
                    return int(parsed * 1024)
                if "kb" in text:
                    return int(parsed / 1024)
                if parsed > 1024 * 1024:
                    return int(parsed / 1024 / 1024)
                return int(parsed)
    return 0


def _safe_call(module: Any, name: str, *args: Any) -> Any:
    func = getattr(module, name, None)
    if func is None:
        return None
    try:
        return func(*args)
    except Exception:
        return None


def _dict_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int_or_none(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except Exception:
        return None


def _nvml_temperature(pynvml: Any, handle: Any) -> float | None:
    try:
        return float(pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU))
    except Exception:
        return None


def _nvml_power(pynvml: Any, handle: Any) -> float | None:
    try:
        return float(pynvml.nvmlDeviceGetPowerUsage(handle) / 1000)
    except Exception:
        return None


def _occupied(mem_used_mib: int, util_pct: float, settings: Settings) -> bool:
    return mem_used_mib > settings.occupancy_mem_mb or util_pct > settings.occupancy_util


def _float_or_zero(value: str) -> float:
    parsed = _float_or_none(value)
    return float(parsed or 0)


def _float_or_none(value: Any) -> float | None:
    try:
        text = str(value).replace("W", "").replace("%", "").strip()
        if text in {"", "N/A", "nan"}:
            return None
        try:
            return float(text)
        except ValueError:
            match = re.search(r"-?\d+(?:\.\d+)?", text)
            return float(match.group(0)) if match else None
    except Exception:
        return None


def _first_number(data: dict[str, Any], keys: list[str]) -> float | None:
    for key in keys:
        if key in data:
            return _float_or_none(data[key])
    return None


def _framework_checks(vendors: list[str]) -> list[FrameworkCheck]:
    script = r"""
import importlib.util, json
result = []
for name in ["torch", "jax", "tensorflow"]:
    if importlib.util.find_spec(name) is None:
        result.append({"name": name, "installed": False})
        continue
    try:
        if name == "torch":
            import torch
            build = "cpu"
            if getattr(torch.version, "hip", None):
                build = "rocm"
            elif getattr(torch.version, "cuda", None):
                build = "cuda"
            count = int(torch.cuda.device_count()) if hasattr(torch, "cuda") else 0
            result.append({"name": name, "installed": True, "build": build, "sees_gpu": bool(torch.cuda.is_available()), "device_count": count})
        elif name == "jax":
            import jax
            devices = jax.devices()
            platforms = {getattr(device, "platform", "") for device in devices}
            build = "cuda" if "gpu" in platforms or "cuda" in platforms else ("rocm" if "rocm" in platforms else "cpu")
            result.append({"name": name, "installed": True, "build": build, "sees_gpu": build != "cpu", "device_count": len(devices)})
        elif name == "tensorflow":
            import tensorflow as tf
            devices = tf.config.list_physical_devices("GPU")
            result.append({"name": name, "installed": True, "build": None, "sees_gpu": bool(devices), "device_count": len(devices)})
    except Exception as exc:
        result.append({"name": name, "installed": True, "warning": str(exc)})
print(json.dumps(result))
"""
    completed = subprocess.run(
        [sys.executable, "-c", script],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
    )
    raw_checks: list[dict[str, Any]]
    try:
        raw_checks = json.loads(completed.stdout.splitlines()[-1]) if completed.stdout else []
    except Exception:
        raw_checks = []
    checks = [FrameworkCheck.model_validate(item) for item in raw_checks]
    for check in checks:
        if not check.installed:
            continue
        if "amd" in vendors and check.name == "torch" and check.build != "rocm":
            check.warning = check.warning or "AMD GPU detected but torch is not a ROCm build."
        if "nvidia" in vendors and check.name == "torch" and check.build == "cpu":
            check.warning = check.warning or "NVIDIA GPU detected but torch is CPU-only."
        if vendors and check.sees_gpu is False:
            check.warning = check.warning or f"{check.name} does not see a GPU."
    return checks
