import type { Env } from "./env";
import { runOnce } from "./pipeline";
import { authorizeUrl, completeConnect, Xero } from "./xero";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runOnce(env).then((r) => {
        if (r.length) console.log(JSON.stringify(r));
      }),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const authed = !!env.ADMIN_TOKEN && url.searchParams.get("key") === env.ADMIN_TOKEN;

    if (url.pathname === "/xero/callback") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code || !(await env.STATE.get(`oauth-state:${state}`))) return new Response("Invalid state", { status: 400 });
      await env.STATE.delete(`oauth-state:${state}`);
      const org = await completeConnect(env, code);
      return new Response(`Connected to Xero organisation "${org.tenantName}". You can close this tab.`);
    }

    if (!authed) return new Response("Not found", { status: 404 });

    switch (url.pathname) {
      case "/xero/connect": {
        const state = crypto.randomUUID();
        await env.STATE.put(`oauth-state:${state}`, "1", { expirationTtl: 600 });
        return Response.redirect(authorizeUrl(env, state), 302);
      }
      case "/admin/run":
        return json(await runOnce(env));
      case "/admin/bank-accounts":
        return json(await new Xero(env).bankAccounts());
      case "/admin/bank-lines": {
        const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
        const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
        const xero = new Xero(env);
        if (url.searchParams.has("raw")) return json(await xero.rawBankStatement(env.XERO_BANK_ACCOUNT_ID, from, to));
        return json(await xero.statementLines(env.XERO_BANK_ACCOUNT_ID, from, to));
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
