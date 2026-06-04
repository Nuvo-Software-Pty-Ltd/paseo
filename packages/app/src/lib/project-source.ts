// D-3.5a (app T-5) — capability-driven project-source selection.
//
// The picker's available sources are driven entirely by the daemon's
// `server_info.features.projectSource` capability — NEVER by a cloud/Electron/
// platform constant (open-core discipline). An old daemon that does not emit
// the field defaults to "local_and_github" so both sources stay available
// (the safe superset).

export type ProjectSource = "local_and_github" | "github_only" | "local_only";

interface ServerInfoLike {
  features?: { projectSource?: ProjectSource } | undefined;
}

export function resolveProjectSource(serverInfo: ServerInfoLike | null | undefined): ProjectSource {
  return serverInfo?.features?.projectSource ?? "local_and_github";
}

export function projectSourceAllowsLocalDirectory(source: ProjectSource): boolean {
  return source === "local_and_github" || source === "local_only";
}

export function projectSourceAllowsGithub(source: ProjectSource): boolean {
  return source === "local_and_github" || source === "github_only";
}
