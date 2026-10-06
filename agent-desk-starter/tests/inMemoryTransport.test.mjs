import { registerTransportContract } from "./helpers/transportContract.mjs";
import { InMemoryTransport } from "../backend/messaging/inMemoryTransport.mjs";

registerTransportContract({
  name: "memory",
  createHarness: async () => {
    const transport = new InMemoryTransport();
    return { transport, cleanup: () => transport.close() };
  },
});

