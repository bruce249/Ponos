// Why this exists: asn1-ts 8.0.5 is CommonJS and defines DERElement/ASN1Element with
// `get: function () { return __importDefault(x).default; }`, which Node's CJS export
// analysis does not recognise. `import { DERElement } from "asn1-ts"` then throws
// "does not provide an export named 'DERElement'" (hedera-custodians-integration, used by
// @hashgraph/stablecoin-npm-sdk). Only these names are imported by that SDK.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const real = require("asn1-ts-cjs");

export const { ASN1Element, BERElement, CERElement, DERElement, ASN1TagClass, ASN1UniversalType } = real;
export default real;
