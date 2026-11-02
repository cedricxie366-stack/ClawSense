import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
type Observer = {
    before(): Promise<void>;
    after(): Promise<void>;
};
const coordinators = new Map<string, WorkspaceCoordinator>();
const active = new AsyncLocalStorage<string>();
export function contextRoot(root: string): string { const absolute = path.resolve(root); let existing = absolute; const parts: string[] = []; while (!fsSync.existsSync(existing)) { parts.unshift(path.basename(existing)); existing = path.dirname(existing); } return path.join(fsSync.realpathSync(existing), ...parts); }
/** One lock spans the legacy stores and their common version/deletion catalog. */
export class WorkspaceCoordinator {
    private chain: Promise<unknown> = Promise.resolve();
    private observer?: Observer;
    readonly root: string;
    readonly directory: string;
    constructor(root: string) { this.root = contextRoot(root); this.directory = path.join(this.root, "plugins", "clawsense", "unified"); }
    observe(observer: Observer) { this.observer = observer; }
    async run<T>(operation: () => Promise<T>, write = false): Promise<T> {
        if (active.getStore() === this.root)
            return operation();
        if (!this.observer)
            return operation();
        const pending = this.chain.catch(() => { }).then(async () => {
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            for (const suffix of [["plugins"], ["plugins", "clawsense"], ["plugins", "clawsense", "unified"]]) if ((await fs.lstat(path.join(this.root, ...suffix))).isSymbolicLink()) throw new Error("context_directory_symlink");
            if ((await fs.lstat(this.directory)).isSymbolicLink())
                throw new Error("context_directory_symlink");
            await this.claimAuthority();
            const lock = path.join(this.directory, ".write-lock"), intent = path.join(this.directory, "write-intent.json");
            const deadline = Date.now() + 15000;
            for (;;) {
                try {
                    await fs.mkdir(lock, { mode: 0o700 });
                    break;
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
                        throw new Error("context_writer_busy");
                    await new Promise((resolve) => setTimeout(resolve, 15));
                }
            }
            try {
                await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, root: this.root, acquiredAt: Date.now() }), { flag: "wx", mode: 0o600 });
                return await active.run(this.root, async () => {
                    // Reconcile a durable prior intent before allowing any new operation.
                    await this.observer!.before();
                    if (write) await atomicContextJson(intent, { version: 1, id: randomUUID(), startedAt: Date.now(), pid: process.pid });
                    try {
                        return await operation();
                    }
                    finally {
                        await this.observer!.after();
                        if (write) await fs.rm(intent, { force: true });
                    }
                });
            }
            finally {
                await fs.rm(lock, { recursive: true, force: true });
            }
        });
        this.chain = pending.then(() => undefined, () => undefined);
        return pending;
    }
    private async claimAuthority(): Promise<void> {
        if (await fs.access(path.join(this.root, "context-authority-moved.json")).then(() => true, () => false)) throw new Error("workspace_authority_moved");
        const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
        const standaloneOwner = path.join(this.root, ".standalone.lock", "owner.json");
        try { const owner = JSON.parse(await fs.readFile(standaloneOwner, "utf8")); if (Number.isSafeInteger(owner.pid) && owner.pid !== process.pid && alive(owner.pid)) throw new Error("context_authority_conflict"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const file = path.join(this.directory, "authority.json");
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const handle = await fs.open(file, "wx", 0o600);
                try { await handle.writeFile(JSON.stringify({ pid: process.pid, root: this.root, claimedAt: Date.now() })); await handle.sync(); } finally { await handle.close(); }
                return;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_context_authority");
                const body = await fs.readFile(file, "utf8");
                if (!body && attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 20)); continue; }
                const owner = JSON.parse(body); if (!Number.isSafeInteger(owner.pid) || owner.root !== this.root) throw new Error("invalid_context_authority");
                if (owner.pid === process.pid) return;
                if (alive(owner.pid)) throw new Error("context_authority_conflict");
                if (await fs.readFile(file, "utf8") !== body) throw new Error("context_authority_changed");
                await fs.rm(file);
            }
        }
        throw new Error("context_authority_busy");
    }
    async release(): Promise<void> { const file = path.join(this.directory, "authority.json"); const owner = await fs.readFile(file, "utf8").then((body) => JSON.parse(body)).catch((error) => { if (error.code !== "ENOENT") throw error; return null; }); if (owner?.pid === process.pid) await fs.rm(file, { force: true }); }
}
export function workspaceCoordinator(root: string): WorkspaceCoordinator {
    const key = contextRoot(root);
    let value = coordinators.get(key);
    if (!value) {
        value = new WorkspaceCoordinator(key);
        coordinators.set(key, value);
    }
    return value;
}
export function coordinatedMutation<T>(root: string, operation: () => Promise<T>): Promise<T> { return workspaceCoordinator(root).run(operation, true); }
export function coordinatedRead<T>(root: string, operation: () => Promise<T>): Promise<T> { return workspaceCoordinator(root).run(operation, false); }
export async function atomicContextJson(file: string, value: unknown, committed?: (identity: { ino: number; size: number; mtimeMs: number }) => void): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let written: { ino: number; size: number; mtimeMs: number } | undefined;
    try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
            await handle.sync();
            if (committed) { const stat = await handle.stat(); written = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }; }
        }
        finally {
            await handle.close();
        }
        await fs.rename(temporary, file);
        const parent = await fs.open(path.dirname(file), "r");
        try {
            await parent.sync();
        }
        finally {
            await parent.close();
        }
        if (written) committed?.(written);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
}
