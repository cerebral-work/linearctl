import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { setProjectOverview } from "../src/core/projects.js";

describe("setProjectOverview", () => {
  test("refuses empty content before touching the API", async () => {
    // The guard fires before any client call, so a hollow client proves it:
    // if the guard were missing this would throw a TypeError instead.
    const client = {} as LinearClient;
    expect(setProjectOverview(client, "any-project", "")).rejects.toThrow(
      /refusing to write an empty overview/,
    );
    expect(setProjectOverview(client, "any-project", "  \n\t ")).rejects.toThrow(
      /refusing to write an empty overview/,
    );
  });
});
