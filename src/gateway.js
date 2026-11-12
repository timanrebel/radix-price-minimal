import Decimal from "decimal.js";

export const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
export const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export async function httpJson(url, env, body, deadline) {
  const timeout = AbortSignal.timeout(Number(env.HTTP_TIMEOUT ?? 10) * 1000);
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "minprice/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function gateway(env, path, body, deadline) {
  const base = env.GATEWAY_URL ?? "https://mainnet.radixdlt.com";
  return httpJson(base.replace(/\/+$/, "") + path, env, body, deadline);
}

async function preview(env, manifest, epoch, deadline) {
  const { receipt } = await gateway(env, "/transaction/preview", {
    manifest,
    start_epoch_inclusive: epoch,
    end_epoch_exclusive: epoch + 2,
    tip_percentage: 0,
    nonce: 1,
    signer_public_keys: [{
      key_type: "EcdsaSecp256k1",
      key_hex: "0388207bf34f38fe057884e1efba2f54d1bfb3daf59894db12b1709315cfc77617",
    }],
    flags: {
      use_free_credit: true,
      assume_all_signature_proofs: true,
      skip_epoch_check: true,
      disable_auth_checks: false,
    },
  }, deadline);
  if (receipt.status != null && receipt.status !== "Succeeded") {
    throw new Error(`preview ${receipt.status}: ${String(receipt.error_message ?? "").slice(0, 160)}`);
  }
  return receipt.output.map(output => output.programmatic_json);
}

function call(component, method, args = "") {
  return `CALL_METHOD\nAddress("${component}")\n"${method}"\n${args};`;
}

function quoteArgs(amount, isQuote) {
  const literal = amount.toFixed(18).replace(/\.?0+$/, "");
  return `Decimal("${literal || "0"}")\n${isQuote}\n`;
}

export async function poolRaw(env, pool, epoch, deadline) {
  const { dex, component } = pool;
  const method = { ociswap: "price_sqrt", c9: "get_price", defiplaza: "get_state" }[dex];
  if (!method) throw new Error(`unsupported dex: ${dex}`);
  const [out] = await preview(env, call(component, method), epoch, deadline);
  let raw;
  if (dex === "ociswap") {
    raw = new D(out.fields ? out.fields[0].value : out.value).pow(2);
  } else if (dex === "c9") {
    raw = new D(out.fields[0].value);
  } else {
    const p0 = new D((out.fields.find(field => field.field_name === "p0") ?? out.fields[0]).value);
    if (!p0.gt(0)) throw new Error("p0 <= 0");
    const quoteIn = new D(env.PLAZA_PROBE_QUOTE ?? "100");
    const baseIn = quoteIn.div(p0);
    const [sell, buy] = await preview(env, [
      call(component, "quote", quoteArgs(baseIn, false)),
      call(component, "quote", quoteArgs(quoteIn, true)),
    ].join("\n"), epoch, deadline);

    const gross = ({ fields }) => new D(fields[0].value).plus(fields[2].value);
    const quoteOut = gross(sell);
    const baseOut = gross(buy);
    const baseSpent = baseIn.minus(sell.fields[1].value);
    const quoteSpent = quoteIn.minus(buy.fields[1].value);
    if ([quoteOut, baseOut, baseSpent, quoteSpent].some(value => !value.gt(0))) {
      throw new Error("no liquidity on one side");
    }
    raw = new D(1).div(quoteOut.div(baseSpent).times(quoteSpent.div(baseOut)).sqrt());
  }
  if (!raw.isFinite() || !raw.gt(0)) throw new Error("invalid pool price");
  return raw;
}

export async function redemptionValues(env, addresses) {
  const { items } = await gateway(env, "/state/entity/details", {
    addresses, aggregation_level: "Vault", explicit_metadata: ["validator"],
  });
  const supply = new Map();
  const validators = new Set();
  for (const item of items) {
    const typed = item.metadata?.items.find(entry => entry.key === "validator")?.value.typed;
    if (typed?.type === "GlobalAddress" && typed.value.startsWith("validator_")) {
      supply.set(item.address, Number(item.details.total_supply));
      validators.add(typed.value);
    }
  }
  if (!validators.size) return new Map();
  const data = await gateway(env, "/state/entity/details", {
    addresses: [...validators], aggregation_level: "Vault",
  });
  const values = new Map();
  for (const validator of data.items) {
    const state = validator.details.state;
    const address = state.stake_unit_resource_address;
    if (!supply.has(address)) continue;
    const resource = validator.fungible_resources.items.find(item => item.resource_address === XRD);
    const vault = resource?.vaults.items.find(item => item.vault_address === state.stake_xrd_vault.entity_address);
    const value = Number(vault?.amount) / supply.get(address);
    if (Number.isFinite(value) && value >= 0) values.set(address, value);
  }
  return values;
}
