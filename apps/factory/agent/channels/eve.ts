import { timingSafeEqual } from "node:crypto";
import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const authenticateRunner: AuthFn<Request> = (request) => {
  // Read at request time: Eve compiles this channel without a runner token.
  // The launcher injects a fresh token only into the live child environment.
  const expected = process.env.VGPU_FACTORY_LOCAL_TOKEN;
  const supplied = /^Bearer ([a-f0-9]{64})$/i.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  if (
    expected === undefined ||
    expected.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    supplied === undefined ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  ) {
    return null;
  }
  // A principal is durable metadata; never include the credential in it.
  return {
    attributes: {},
    authenticator: "factory-local-bearer",
    principalId: "factory-runner",
    principalType: "service",
  };
};

export default eveChannel({ auth: authenticateRunner, cors: false });
