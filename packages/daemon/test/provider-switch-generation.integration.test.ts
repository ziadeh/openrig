import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon } from "./helpers/scenario-daemon.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

// A Claude seat switched in place is relaunched in its own pane, and the relaunch registers a new occupant generation.
// The relaunched process must carry that generation, or every hook it posts reads as a dead earlier occupant's
// (generation_mismatch, so "unknown"). Both resume paths are covered: the classic one (no permission mode selected) and
// the managed one (a selected mode). Only Claude is synthetic; its hooks go through the shipped relay.
it.skipIf(process.platform === "win32")("a Claude seat switched in place posts hooks under its new occupant generation, so a busy seat reads working", async () => {
  const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");
  let daemon: Awaited<ReturnType<typeof spawnScenarioDaemon>> | undefined;
  let db: Database.Database | undefined;
  const tmux = (...args: string[]) => execFileSync("tmux", args, { env: scaffold.env, encoding: "utf8", stdio: "pipe" }).trim();
  const until = async (predicate: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`synthetic provider did not settle: ${what}`);
  };
  try {
    const binary = join(scaffold.root, "bin", "claude");
    execFileSync("cc", [fileURLToPath(new URL("fixtures/provider-switch-claude.c", import.meta.url)), "-o", binary, `-DFIXTURE_NODE=${JSON.stringify(process.execPath)}`,
      `-DFIXTURE_RELAY=${JSON.stringify(fileURLToPath(new URL("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url)))}`]);
    const planFile = join(scaffold.root, "plan-token");
    writeFileSync(planFile, "synthetic-plan", { mode: 0o600 });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin, timeoutMs: 60_000 });
    db = new Database(join(scaffold.stateDir, "scenario.db")); db.pragma("busy_timeout = 5000");
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    // The daemon's own reading of a hook record, with its occupant-generation gate (startup.ts).
    const hooks = new AgentActivityStore({ db, eventBus: { emit: () => undefined } as never,
      resolveOccupantGeneration: (nodeId) => sessions.currentOccupantTenure(nodeId)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (nodeId, generation) => sessions.isOccupantGenerationRegistered(nodeId, generation),
      isOccupantContinuedByAdoption: (nodeId, generation) => sessions.isOccupantContinuedByAdoption(nodeId, generation) });
    const hookRows = (nodeId: string) => db!.prepare("SELECT json_extract(payload, '$.activity.rawEvent') AS event, json_extract(payload, '$.activity.generation') AS generation FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq")
      .all(nodeId) as Array<{ event: string; generation: string | null }>;
    const launches = () => { try { return readFileSync(join(scaffold.openrigHome, "provider-launches.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
    const rig = rigs.createRig("generation-fixture");

    for (const [name, mode] of [["classic", null], ["managed", "acceptEdits"]] as const) {
      const home = join(scaffold.root, `config-${name}`); mkdirSync(home);
      const node = rigs.addNode(rig.id, `work.${name}`, { runtime: "claude-code", cwd: scaffold.root, model: "fixture-model", restorePolicy: "resume_if_possible" });
      db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(home, node.id);
      if (mode) new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode }, "fixture", "fixture launch mode");
      const seat = `r00-generation-fixture-work_${name}`, conversation = randomUUID();
      tmux("new-session", "-d", "-s", seat, "exec /bin/bash --noprofile --norc");
      const pane = tmux("display-message", "-p", "-t", seat, "#{pane_id}");
      const session = sessions.registerSession(node.id, seat);
      sessions.updateStatus(session.id, "running"); sessions.updateResumeToken(session.id, "claude_id", conversation, "operator");
      sessions.updateStartupStatus(session.id, "ready"); sessions.updateBinding(node.id, { tmuxSession: seat, tmuxPane: pane });
      const first = sessions.currentOccupantTenure(node.id)!.generationUuid;
      const identity = { OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: seat, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: first };
      for (const [key, value] of Object.entries(identity)) tmux("set-environment", "-t", seat, key, value);
      // The first launch exports the seat's identity, as a real launch does; the relay finds the daemon through OPENRIG_HOME.
      const exports = Object.entries({ ...identity, OPENRIG_HOME: scaffold.openrigHome }).map(([k, v]) => `export ${k}=${shellQuote(v)}; `).join("");
      const before = launches().length;
      tmux("send-keys", "-t", pane, "-l", `${exports}export CLAUDE_CONFIG_DIR=${shellQuote(home)}; ${shellQuote(binary)} --resume ${conversation} --model fixture-model${mode ? ` --permission-mode ${mode}` : ""}`);
      tmux("send-keys", "-t", pane, "Enter");
      await until(() => launches().length === before + 1, `${name} launched`);
      await until(() => hookRows(node.id).length === 1, `${name}'s first SessionStart relayed`);
      expect(hookRows(node.id)[0]).toEqual({ event: "SessionStart", generation: first });

      // The switch relaunches the seat in its own pane on the token.
      const switched = await runRig(["provider", "switch", "--seat", seat, "--to-account", "plan", "--token-file", planFile, "--json"], daemon.readEnv, rigBin, 120_000);
      expect(switched.code, JSON.stringify(switched)).toBe(0);
      expect(JSON.parse(switched.stdout)).toMatchObject({ seat: { restart: { outcome: "resumed" } } });
      await until(() => launches().length === before + 2, `${name} relaunched`);
      expect(tmux("display-message", "-p", "-t", seat, "#{pane_id}")).toBe(pane);
      const live = sessions.currentOccupantTenure(node.id)!.generationUuid;
      expect(live, `${name}: the relaunch registers a new occupant`).not.toBe(first);

      // A turn starts in the relaunched seat: its hook carries the live generation, and the daemon reads it as working.
      tmux("send-keys", "-t", pane, "busy", "Enter");
      await until(() => hookRows(node.id).some((r) => r.event === "UserPromptSubmit"), `${name}'s UserPromptSubmit relayed`);
      expect(hookRows(node.id).filter((r) => r.event === "UserPromptSubmit").map((r) => r.generation), name).toEqual([live]);
      expect(tmux("show-environment", "-t", seat, "OPENRIG_OCCUPANT_GENERATION"), name).toBe(`OPENRIG_OCCUPANT_GENERATION=${live}`);
      expect(hooks.getLatestForNode({ nodeId: node.id, sessionName: seat, order: "source" }), name).toMatchObject({ state: "running", stale: false });
    }
  } finally {
    db?.close();
    if (daemon) await daemon.stop(); else scaffold.cleanup();
  }
}, 300_000);
