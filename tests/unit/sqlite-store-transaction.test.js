import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../../dist/memory/sqlite-store.js";

function openFresh(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, "memory.sqlite") };
}

test("transaction: immediate mode takes the write lock at BEGIN; the default stays deferred", () => {
  const { dir, dbPath } = openFresh("pir-txn-");
  const store = SqliteStore.open(dbPath);
  store.run("CREATE TABLE atomic_probe (v INTEGER)");
  try {
    // Default (deferred): a transaction that has only read does not block a
    // second connection's write in WAL mode.
    store.transaction(() => {
      store.get("SELECT COUNT(*) AS n FROM atomic_probe");
      const other = new DatabaseSync(dbPath);
      other.exec("PRAGMA busy_timeout = 0");
      try {
        other.exec("INSERT INTO atomic_probe (v) VALUES (1)");
      } finally {
        other.close();
      }
    });
    assert.equal(store.get("SELECT COUNT(*) AS n FROM atomic_probe").n, 1);

    // Immediate: the write lock is held from BEGIN, so another connection
    // cannot write even though this transaction has not written yet. That is
    // what makes a read-then-write sequence (COUNT(*) + 1, then INSERT) race
    // free.
    store.transaction(
      () => {
        const other = new DatabaseSync(dbPath);
        other.exec("PRAGMA busy_timeout = 0");
        try {
          assert.throws(
            () => other.exec("INSERT INTO atomic_probe (v) VALUES (2)"),
            /database is locked|SQLITE_BUSY/i,
          );
        } finally {
          other.close();
        }
      },
      { immediate: true },
    );
    assert.equal(store.get("SELECT COUNT(*) AS n FROM atomic_probe").n, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transaction: immediate mode commits and rolls back like the default", () => {
  const { dir, dbPath } = openFresh("pir-txn-rollback-");
  const store = SqliteStore.open(dbPath);
  store.run("CREATE TABLE atomic_probe (v INTEGER)");
  try {
    const value = store.transaction(
      () => {
        store.run("INSERT INTO atomic_probe (v) VALUES (?)", 7);
        return store.get("SELECT v FROM atomic_probe").v;
      },
      { immediate: true },
    );
    assert.equal(value, 7);

    assert.throws(
      () =>
        store.transaction(
          () => {
            store.run("INSERT INTO atomic_probe (v) VALUES (?)", 8);
            throw new Error("boom");
          },
          { immediate: true },
        ),
      /boom/,
    );
    assert.deepEqual(
      store.all("SELECT v FROM atomic_probe ORDER BY v").map((row) => row.v),
      [7],
    );
    // The failed transaction released the write lock: a later immediate
    // transaction still succeeds.
    store.transaction(() => store.run("INSERT INTO atomic_probe (v) VALUES (?)", 9), { immediate: true });
    assert.equal(store.get("SELECT COUNT(*) AS n FROM atomic_probe").n, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
