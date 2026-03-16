/**
 * Multi-agent routing module.
 *
 * Routes channels to agents based on configurable rules and supports
 * Ed25519-signed delegation chains for multi-agent trust propagation.
 *
 * @module
 */

export {
  type AgentRouter,
  type AgentRouterConfig,
  createAgentRouter,
  type RouteRule,
} from "./router.ts";

export {
  createDelegationService,
  type DelegationCertificate,
  type DelegationChain,
  type DelegationKeypair,
  type DelegationService,
  type UnsignedCertificate,
} from "./delegation.ts";

export {
  buildCertificatePayload,
  decodeBase64,
  deserialiseDelegationChain,
  encodeBase64,
  serialiseDelegationChain,
} from "./delegation_codec.ts";
export type { SerialisedCertificate } from "./delegation_codec.ts";

export {
  generateDelegationKeypair,
  signDelegationCertificate,
  verifyDelegationCertificate,
  verifyDelegationChainLinkage,
} from "./delegation_crypto.ts";
