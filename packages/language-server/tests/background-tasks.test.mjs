import assert from "node:assert/strict";
import test from "node:test";

import { BackgroundTaskSupervisor } from "../src/background-tasks.mjs";

test("reports detached task failures without leaking a rejected promise", async () => {
  const reported = [];
  const supervisor = new BackgroundTaskSupervisor((label, error) => {
    reported.push({ label, error });
  });
  const failure = new Error("parse failed");

  await assert.doesNotReject(
    supervisor.run("document update", async () => {
      throw failure;
    }),
  );
  assert.deepEqual(reported, [{ label: "document update", error: failure }]);
});

test("runs successful detached work without reporting an error", async () => {
  const reported = [];
  const supervisor = new BackgroundTaskSupervisor((label, error) => {
    reported.push({ label, error });
  });
  let completed = false;

  await supervisor.run("workspace index", async () => {
    completed = true;
  });
  assert.equal(completed, true);
  assert.deepEqual(reported, []);
});
