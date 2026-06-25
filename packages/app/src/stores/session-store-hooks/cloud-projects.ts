// Orchestra cloud hooks re-homed here during the upstream-0.1.99 merge. Upstream
// split the former flat `session-store-hooks.ts` into this directory; our two
// cloud-only project selectors live in their own file to keep the open-core
// delta isolated and minimize future merge friction.
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "../session-store";
import { resolveProjectSource, type ProjectSource } from "@/lib/project-source";
import { workspaceProjects } from "@/lib/workspace-projects";
import type { AutomationProjectOption } from "@/components/automations/automation-target-model";

const EMPTY_SERVER_PROJECTS: AutomationProjectOption[] = [];

// D-3.5a (app T-5) — capability-driven project-source selector. The picker's
// available sources are decided ENTIRELY by the connected daemon's
// `server_info.features.projectSource`, never by a cloud/Electron/platform
// constant (open-core discipline). An old daemon that omits the field defaults
// to "local_and_github" (the safe superset) via `resolveProjectSource`.
export function useProjectSource(serverId: string | null): ProjectSource {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId) {
        return resolveProjectSource(null);
      }
      return resolveProjectSource(state.sessions[serverId]?.serverInfo ?? null);
    },
    Object.is,
  );
}

// D-3.5d (automation form UX) — the non-archived projects across all of a
// server's workspaces, shaped for the automation "Working directory" picker
// (id = projectId, label = displayName, value = rootPath). Deduped by
// projectId so a project shared by several workspaces appears once. Returns a
// stable empty array when the server has no workspaces (self-host / empty),
// which the picker uses to fall back to a freeform path input.
export function useServerProjects(serverId: string | null): AutomationProjectOption[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId) {
        return EMPTY_SERVER_PROJECTS;
      }
      const workspaces = state.sessions[serverId]?.workspaces;
      if (!workspaces || workspaces.size === 0) {
        return EMPTY_SERVER_PROJECTS;
      }
      const byId = new Map<string, AutomationProjectOption>();
      for (const workspace of workspaces.values()) {
        for (const project of workspaceProjects(workspace)) {
          if (project.archivedAt !== null || byId.has(project.projectId)) {
            continue;
          }
          byId.set(project.projectId, {
            projectId: project.projectId,
            displayName: project.displayName,
            rootPath: project.rootPath,
          });
        }
      }
      return byId.size === 0 ? EMPTY_SERVER_PROJECTS : Array.from(byId.values());
    },
    equal,
  );
}
