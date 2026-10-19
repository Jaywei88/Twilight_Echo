/**
 * IPC payload normalisation.
 *
 * Everything crossing `contextBridge` is serialised with structured clone, which
 * rejects Vue reactive proxies with "An object could not be cloned." The preload
 * cannot help: it never receives the argument, because serialisation happens
 * before the preload function body runs. Callers must hand over plain data.
 *
 * Any renderer code that reads state out of a store/computed and forwards it to
 * the settings IPC has to pass through here first.
 */
export function toPlainIpcPayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
