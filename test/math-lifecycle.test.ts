import assert from "node:assert/strict";
import {
  ConfigurationLifecycle, ConfigurationRecoveryError, DEFAULT_MATH_OPTIONS, snapshotMathOptions,
  type MathOptions,
} from "../src/engine/math-lifecycle.js";

const options = (patch: Partial<MathOptions> = {}): MathOptions => ({ ...DEFAULT_MATH_OPTIONS, ...patch });
let active: MathOptions | undefined;
let applies = 0;
let commits = 0;
const lifecycle = new ConfigurationLifecycle({
  snapshot: snapshotMathOptions,
  apply: async (next) => {
    applies++;
    active = next;
    if (next.macros.bad) throw new Error("invalid configuration");
  },
  committed: () => { commits++; },
});
assert.equal(await lifecycle.configure(options()), true);
assert.equal(await lifecycle.configure(options()), false);
assert.equal(applies, 1);
const mutable = options({ physics: true, macros: { foo: ["#1", 1] } });
const queued = lifecycle.configure(mutable);
mutable.physics = false;
(mutable.macros.foo as [string, number])[0] = "mutated";
await queued;
assert.equal(active?.physics, true);
assert.deepEqual(active?.macros.foo, ["#1", 1]);
await Promise.all([
  lifecycle.configure(options({ mhchem: true })),
  lifecycle.configure(options({ braket: true })),
  lifecycle.configure(options()),
]);
assert.equal(active?.mhchem, false);
assert.equal(active?.braket, false);
assert.equal(active?.physics, false);
const beforeFailure = commits;
await assert.rejects(lifecycle.configure(options({ macros: { bad: "bad" } })), /invalid/);
assert.deepEqual(active, options(), "failed rebuild restores the last committed configuration");
assert.equal(commits, beforeFailure, "failed changes never publish or invalidate caches");
await lifecycle.configure(options({ physics: true }));
assert.equal(active?.physics, true, "a failed request does not poison later requests");
assert.equal(
  snapshotMathOptions(options({ macros: { b: "b", a: "a" } })).key,
  snapshotMathOptions(options({ macros: { a: "a", b: "b" } })).key,
);
let attempts = 0;
const retry = new ConfigurationLifecycle({
  snapshot: snapshotMathOptions,
  apply: () => { if (++attempts === 1) throw new Error("load failed"); },
});
await assert.rejects(retry.configure(options()), /load failed/);
assert.equal(await retry.configure(options()), true, "an initial load failure is retryable");
let broken = false;
let fail = false;
const recovery = new ConfigurationLifecycle({
  snapshot: snapshotMathOptions,
  apply: () => { if (fail) throw new Error("broken"); },
  broken: () => { broken = true; },
});
await recovery.configure(options());
fail = true;
await assert.rejects(recovery.configure(options({ physics: true })), ConfigurationRecoveryError);
assert.equal(broken, true);
fail = false;
assert.equal(await recovery.configure(options()), true);
console.log("ok   math configuration snapshots, ordering, rollback and retry");
