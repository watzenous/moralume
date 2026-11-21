// Built as a separate file and loaded on demand by app.js (dynamic import).
// AmmoraSwapClient (the multi-venue swap router) is most of the SDK's code but is only needed
// for graduated tokens, so keeping it out of the main bundle makes the first page load much smaller.
import { AmmoraSwapClient, giwaSepoliaAutoRouteDeployment as D, giwaSepoliaAutoRoutePoolProfiles } from "@ammora-protocol/sdk";
import { createPublicClient, defineChain, http } from "viem";

export function createSwapClient({ chain, rpc }) {
  const pc = createPublicClient({
    chain: defineChain(chain),
    transport: http(rpc, { retryCount: 4, retryDelay: 700 }),
    batch: { multicall: { wait: 16, batchSize: 4096 } },
  });
  return AmmoraSwapClient.create(pc, { deploymentCatalog: { [D.chain.id]: D }, factoryProfiles: giwaSepoliaAutoRoutePoolProfiles });
}
