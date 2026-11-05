import assert from "node:assert/strict";
import test from "node:test";
import type { MyContext } from "../src/types.js";
import { UserSessionPersistenceError } from "../src/services/user-session-storage.js";

process.env.SUPABASE_URL = "https://session-alerts.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

let writeMode: "fail" | "ok" = "fail";

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.includes("zeus_read_user_session")) {
    return json([], 200);
  }
  if (url.includes("zeus_write_user_session")) {
    if (writeMode === "fail") {
      return json({ code: "08006", message: "database unavailable" }, 503);
    }
    return json([{ version: 1 }], 200);
  }
  return json({ code: "08006", message: "database unavailable" }, 503);
}) as typeof fetch;

const { sessionMiddleware, pendingSessionUpdates } = await import(
  "../src/middleware/session.js"
);

function buildContext(
  updateId: number,
  userId = 900000301,
): {
  context: MyContext;
  replies: string[];
} {
  const replies: string[] = [];
  const user = {
    id: userId,
    is_bot: false,
    first_name: "User",
  };
  const chat = { id: user.id, type: "private" as const };
  const message = {
    message_id: updateId,
    date: 1,
    text: "/menu",
    from: user,
    chat,
  };
  const context = {
    update: { update_id: updateId, message },
    message,
    chat,
    from: user,
    me: { id: 900000302, is_bot: true, first_name: "ZEUS" },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
    api: {},
  } as unknown as MyContext;
  return { context, replies };
}

async function runUpdate(context: MyContext): Promise<void> {
  await sessionMiddleware(context, async () => {
    context.session.user.pendingAction = {
      kind: "automaticMessage",
      groupId: -100900301,
    };
  });
}

test("un solo aviso por incidente, aviso de recuperación y errores siempre propagados", async () => {
  const logs: string[] = [];
  const originalError = console.error;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.info = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const isPersistenceError = (error: unknown): boolean =>
      error instanceof UserSessionPersistenceError &&
      error.operation === "write" &&
      error.reason === "unavailable";

    // Fase 1: primer fallo -> un aviso.
    writeMode = "fail";
    const first = buildContext(1);
    await assert.rejects(
      () => runUpdate(first.context),
      isPersistenceError,
      "el error de persistencia siempre se propaga",
    );
    assert.equal(first.replies.length, 1);
    assert.match(first.replies[0] ?? "", /No se pudo guardar o recuperar/u);
    assert.match(first.replies[0] ?? "", /no se considera persistida/u);
    assert.ok(
      logs.some((line) =>
        line.includes("occurrence=1") && line.includes("notice=sent")),
      "registro técnico detallado en el primer fallo",
    );

    // Fase 2: fallos equivalentes repetidos -> sin nuevos avisos.
    for (let i = 0; i < 3; i += 1) {
      const repeated = buildContext(2 + i);
      await assert.rejects(() => runUpdate(repeated.context), isPersistenceError);
      assert.equal(
        repeated.replies.length,
        0,
        "sin cascada de avisos: los fallos repetidos solo se registran en logs",
      );
    }
    assert.ok(
      logs.some((line) =>
        line.includes("occurrence=4") && line.includes("notice=grouped")),
      "los fallos agrupados siguen registrándose con detalle",
    );

    // Fase 3: Supabase vuelve -> aviso de recuperación único en ese contexto.
    writeMode = "ok";
    const recovered = buildContext(10);
    await runUpdate(recovered.context);
    assert.equal(recovered.replies.length, 1, "un solo aviso de recuperación");
    assert.match(recovered.replies[0] ?? "", /se ha restaurado/u);
    assert.ok(
      logs.some((line) => line.includes("Persistencia restaurada")),
      "recuperación registrada en logs",
    );

    // Fase 4: éxitos posteriores -> sin avisos adicionales.
    const stable = buildContext(11);
    await runUpdate(stable.context);
    assert.equal(stable.replies.length, 0, "sin avisos tras la recuperación");
  } finally {
    console.error = originalError;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test("la cola por usuario se drena tras fallos y éxitos sin acumular memoria", async () => {
  writeMode = "fail";
  const failing = buildContext(41);
  await assert.rejects(() => runUpdate(failing.context));
  writeMode = "ok";
  const succeeding = buildContext(42);
  await runUpdate(succeeding.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingSessionUpdates(), 0, "sin residuos en la cola");
});

test("actualizaciones concurrentes del mismo usuario se serializan sin conflictos", async () => {
  const order: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (args.map(String).join(" ").includes("USER SESSION")) return;
    originalError(...args);
  };
  try {
    writeMode = "ok";
    const a = buildContext(21);
    const b = buildContext(22);
    const runA = runUpdate(a.context);
    // Lanza la segunda actualización mientras la primera aún está en curso.
    const runB = runUpdate(b.context);
    const results = await Promise.allSettled([runA, runB]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "fulfilled");
    order.push("done");
    assert.equal(order.length, 1);
    assert.equal(a.replies.length, 0, "sin avisos cuando todo persiste");
    assert.equal(b.replies.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("usuarios distintos operan en paralelo: la cola es por usuario, no global", async () => {
  writeMode = "ok";
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (args.map(String).join(" ").includes("USER SESSION")) return;
    originalError(...args);
  };
  const a = buildContext(61, 900000901);
  const b = buildContext(62, 900000902);
  let releaseA: () => void = () => {};
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  try {
    // La actualización de A queda bloqueada dentro de su handler…
    const runA = sessionMiddleware(a.context, async () => {
      await gateA;
    });
    await new Promise((resolve) => setImmediate(resolve));
    // …mientras B (otro usuario) debe completarse sin esperar a la cola de A.
    const outcome = await Promise.race([
      runUpdate(b.context).then(() => "completed"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 400)),
    ]);
    assert.equal(
      outcome,
      "completed",
      "el usuario B no debe esperar a la cola del usuario A",
    );
    assert.equal(b.replies.length, 0);
  } finally {
    releaseA();
    console.error = originalError;
  }
  const runA = sessionMiddleware(a.context, async () => {});
  await runA;
  assert.equal(a.replies.length, 0);
});
