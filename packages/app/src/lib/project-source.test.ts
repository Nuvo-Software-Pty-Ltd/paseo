import { describe, expect, test } from "vitest";

import {
  projectSourceAllowsGithub,
  projectSourceAllowsLocalDirectory,
  resolveProjectSource,
} from "./project-source";

describe("resolveProjectSource (D-3.5a app T-5)", () => {
  test("defaults to local_and_github when the daemon emits no field (old daemon)", () => {
    expect(resolveProjectSource(null)).toBe("local_and_github");
    expect(resolveProjectSource(undefined)).toBe("local_and_github");
    expect(resolveProjectSource({})).toBe("local_and_github");
    expect(resolveProjectSource({ features: {} })).toBe("local_and_github");
  });

  test("honors the capability value verbatim", () => {
    expect(resolveProjectSource({ features: { projectSource: "github_only" } })).toBe(
      "github_only",
    );
    expect(resolveProjectSource({ features: { projectSource: "local_only" } })).toBe("local_only");
  });

  test("source visibility: local_and_github shows both sources", () => {
    expect(projectSourceAllowsLocalDirectory("local_and_github")).toBe(true);
    expect(projectSourceAllowsGithub("local_and_github")).toBe(true);
  });

  test("source visibility: github_only hides the local directory source (cloud)", () => {
    expect(projectSourceAllowsLocalDirectory("github_only")).toBe(false);
    expect(projectSourceAllowsGithub("github_only")).toBe(true);
  });

  test("source visibility: local_only hides the GitHub source", () => {
    expect(projectSourceAllowsLocalDirectory("local_only")).toBe(true);
    expect(projectSourceAllowsGithub("local_only")).toBe(false);
  });
});
