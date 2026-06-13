async function problemText(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j.detail ?? j.title ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export const api = {
  async get<T>(path: string): Promise<T> {
    const r = await fetch(path);
    if (!r.ok) throw new Error(await problemText(r));
    return r.json() as Promise<T>;
  },
  async post<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(await problemText(r));
    return r.json() as Promise<T>;
  },
  async patch<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await problemText(r));
    return r.json() as Promise<T>;
  },
  async put<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await problemText(r));
    return r.json() as Promise<T>;
  },
  async delete(path: string): Promise<void> {
    const r = await fetch(path, { method: "DELETE" });
    if (!r.ok) throw new Error(await problemText(r));
  },
};
