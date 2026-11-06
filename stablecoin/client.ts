/**
 * Stablecoin Studio session. Types and method names match @hashgraph/stablecoin-npm-sdk 4.4.0.
 * CONFIG_SC / CONFIG_RESERVE / version 1 are that package's own constants, not a token id.
 */
import {
  Account,
  AddFixedFeeRequest,
  BurnRequest,
  CashInRequest,
  ConnectRequest,
  CreateRequest,
  Fees,
  FreezeAccountRequest,
  GetReserveAmountRequest,
  InitializationRequest,
  KYCRequest,
  Network,
  PauseRequest,
  ReserveDataFeed,
  StableCoin,
  SupportedWallets,
  TokenSupplyType,
  UpdateReserveAmountRequest,
  WipeRequest,
} from "@hashgraph/stablecoin-npm-sdk";

/** SDK `CONFIG_SC`. Selects the stablecoin configuration. It is not a token id. */
export const CONFIG_SC = "0x0000000000000000000000000000000000000000000000000000000000000002";
/** SDK `CONFIG_RESERVE`. Selects the demo reserve configuration. It is not a token id. */
export const CONFIG_RESERVE = "0x0000000000000000000000000000000000000000000000000000000000000003";
export const CONFIG_VERSION = 1;

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1/";

export function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing ${name}. See .env.example. No token id is invented.`);
  return v;
}

export function missing(names: string[]): string[] {
  return names.filter((n) => !(process.env[n] ?? "").trim());
}

function endpoints() {
  return {
    network: "testnet" as const,
    mirrorNode: { name: "testnet", baseUrl: MIRROR },
    rpcNode: { name: "hashio", baseUrl: (process.env.HEDERA_JSON_RPC ?? "https://testnet.hashio.io/api").trim() },
  };
}

let initialised = false;

export async function initSdk(): Promise<void> {
  if (initialised) return;
  const factory = (process.env.SCS_FACTORY_ADDRESS ?? "").trim();
  const resolver = (process.env.SCS_RESOLVER_ADDRESS ?? "").trim();
  await Network.init(
    new InitializationRequest({
      ...endpoints(),
      configuration: factory && resolver ? { factoryAddress: factory, resolverAddress: resolver } : undefined,
    }),
  );
  initialised = true;
}

export async function connectRole(accountId: string, privateKey: string): Promise<void> {
  await initSdk();
  await Network.connect(
    new ConnectRequest({
      ...endpoints(),
      wallet: SupportedWallets.CLIENT,
      account: { accountId, privateKey: { key: privateKey, type: "ECDSA" } },
    }),
  );
}

export async function connectEnv(prefix: string): Promise<void> {
  await connectRole(need(`${prefix}_ACCOUNT_ID`), need(`${prefix}_PRIVATE_KEY`));
}

const nullKey = Account.NullPublicKey as unknown as NonNullable<CreateRequest["freezeKey"]>;

export function buildCreateRequest(): CreateRequest {
  return new CreateRequest({
    name: process.env.BUSD_NAME?.trim() || "Byline USD",
    symbol: process.env.BUSD_SYMBOL?.trim() || "bUSD",
    decimals: 6,
    initialSupply: "0",
    supplyType: TokenSupplyType.INFINITE,
    createReserve: true,
    reserveInitialAmount: "0",
    reserveConfigId: (process.env.SCS_RESERVE_CONFIG_ID ?? "").trim() || CONFIG_RESERVE,
    reserveConfigVersion: Number(process.env.SCS_RESERVE_CONFIG_VERSION || CONFIG_VERSION),
    configId: (process.env.SCS_CONFIG_ID ?? "").trim() || CONFIG_SC,
    configVersion: Number(process.env.SCS_CONFIG_VERSION || CONFIG_VERSION),
    grantKYCToOriginalSender: true,
    freezeKey: nullKey,
    kycKey: nullKey,
    wipeKey: nullKey,
    pauseKey: nullKey,
    feeScheduleKey: nullKey,
    proxyOwnerAccount: need("SCS_ADMIN_ACCOUNT_ID"),
    cashInRoleAccount: need("CASHIN_ACCOUNT_ID"),
    burnRoleAccount: need("BURN_ACCOUNT_ID"),
    wipeRoleAccount: need("BURN_ACCOUNT_ID"),
    kycRoleAccount: need("COMPLIANCE_ACCOUNT_ID"),
    freezeRoleAccount: need("COMPLIANCE_ACCOUNT_ID"),
    pauseRoleAccount: need("SCS_ADMIN_ACCOUNT_ID"),
    feeRoleAccount: need("SCS_ADMIN_ACCOUNT_ID"),
    cashInRoleAllowance: "1000000000",
    metadata: "byline-work demo bUSD",
  });
}

/** 1 tinybar, paid in HBAR, so the fee cannot skim the escrow's bUSD balance. Treasury is the collector and is exempt. */
export async function addTinyHbarFee(tokenId: string): Promise<string> {
  await connectEnv("SCS_ADMIN");
  const result = await Fees.addFixedFee(
    new AddFixedFeeRequest({
      tokenId,
      collectorId: need("TREASURY_ACCOUNT_ID"),
      collectorsExempt: true,
      tokenIdCollected: "0.0.0",
      decimals: 8,
      amount: "0.00000001",
    }),
  );
  return result.transactionId ?? "";
}

export async function reserveAmount(tokenId: string): Promise<string> {
  const balance = await ReserveDataFeed.getReserveAmount(new GetReserveAmountRequest({ tokenId }));
  return balance.value.toString();
}

export async function setReserve(reserveAddress: string, amountDecimal: string): Promise<string> {
  await connectEnv("SCS_ADMIN");
  const result = await ReserveDataFeed.updateReserveAmount(new UpdateReserveAmountRequest({ reserveAddress, reserveAmount: amountDecimal }));
  return result.transactionId ?? "";
}

export async function cashIn(targetId: string, amountDecimal: string, tokenId: string): Promise<string> {
  await connectEnv("CASHIN");
  const result = await StableCoin.cashIn(new CashInRequest({ amount: amountDecimal, targetId, tokenId }));
  return result.transactionId ?? "";
}

export async function grantKyc(targetId: string, tokenId: string): Promise<string> {
  await connectEnv("COMPLIANCE");
  const result = await StableCoin.grantKyc(new KYCRequest({ targetId, tokenId }));
  return result.transactionId ?? "";
}

export async function freezeAccount(targetId: string, tokenId: string): Promise<string> {
  await connectEnv("COMPLIANCE");
  const result = await StableCoin.freeze(new FreezeAccountRequest({ targetId, tokenId }));
  return result.transactionId ?? "";
}

export async function unfreezeAccount(targetId: string, tokenId: string): Promise<string> {
  await connectEnv("COMPLIANCE");
  const result = await StableCoin.unFreeze(new FreezeAccountRequest({ targetId, tokenId }));
  return result.transactionId ?? "";
}

export async function pauseToken(tokenId: string): Promise<string> {
  await connectEnv("SCS_ADMIN");
  const result = await StableCoin.pause(new PauseRequest({ tokenId }));
  return result.transactionId ?? "";
}

export async function unpauseToken(tokenId: string): Promise<string> {
  await connectEnv("SCS_ADMIN");
  const result = await StableCoin.unPause(new PauseRequest({ tokenId }));
  return result.transactionId ?? "";
}

export async function burn(amountDecimal: string, tokenId: string): Promise<string> {
  await connectEnv("BURN");
  const result = await StableCoin.burn(new BurnRequest({ amount: amountDecimal, tokenId }));
  return result.transactionId ?? "";
}

export async function wipe(targetId: string, amountDecimal: string, tokenId: string): Promise<string> {
  await connectEnv("BURN");
  const result = await StableCoin.wipe(new WipeRequest({ amount: amountDecimal, targetId, tokenId }));
  return result.transactionId ?? "";
}

export async function createCoin() {
  await connectEnv("SCS_ADMIN");
  return StableCoin.create(buildCreateRequest());
}
