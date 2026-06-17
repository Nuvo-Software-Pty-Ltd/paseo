# shellcheck shell=sh
# Orchestra BYO-runtimes L0 (cloud) — sourced by login shells via /etc/profile.d.
#
# Login shells re-run /etc/profile, which on Debian OVERWRITES $PATH and so
# drops the daemon-injected userspace-toolchain prepend (the daemon sets it on
# the agent/terminal/worktree.setup env, but a login shell resets it).
# /etc/profile.d/* is sourced at the END of /etc/profile, so re-prepend here.
#
# No-op unless the deployment sets PASEO_TOOLCHAIN_PREFIX (cloud RunTask injects
# /workspace/.toolchain). Idempotent (skips if already on PATH). Keep this dir
# list in sync with `pathPrepend` in packages/server/src/server/paseo-env.ts.
if [ -n "${PASEO_TOOLCHAIN_PREFIX:-}" ]; then
  case ":${PATH}:" in
    *":${PASEO_TOOLCHAIN_PREFIX}/bin:"*) : ;;
    *)
      PATH="${PASEO_TOOLCHAIN_PREFIX}/bin:${PASEO_TOOLCHAIN_PREFIX}/npm-global/bin:${PASEO_TOOLCHAIN_PREFIX}/node/bin:${PASEO_TOOLCHAIN_PREFIX}/uv/bin:${PATH}"
      export PATH
      ;;
  esac
fi
