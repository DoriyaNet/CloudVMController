import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import http from "node:http";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function fingerprintFor(publicKey) {
  const digest = createHash("md5")
    .update(createPublicKey(publicKey).export({ type: "spki", format: "der" }))
    .digest("hex");
  return digest.match(/.{2}/g).join(":");
}

function parseAuthorization(value) {
  const entries = [...String(value || "").matchAll(/([a-z]+)="([^"]*)"/gi)];
  return Object.fromEntries(entries.map((match) => [match[1], match[2]]));
}

function json(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

export async function createMockOracle() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const tenancyId =
    "ocid1.tenancy.oc1..aaaaaaaaoracletesttenant0000000000000000000000000000000001";
  const userId =
    "ocid1.user.oc1..aaaaaaaauser0000000000000000000000000000000000000000000001";
  const rootCompartmentId = tenancyId;
  const childCompartmentId =
    "ocid1.compartment.oc1..aaaaaaaachildcompartment0000000000000000000000000001";
  const fingerprint = fingerprintFor(publicKey);
  const instances = [
    {
      id: "ocid1.instance.oc1.us-ashburn-1.anuwgljrjjoracletest000000000000000000000000000001",
      displayName: "oracle-edge",
      compartmentId: rootCompartmentId,
      availabilityDomain: "Uocm:US-ASHBURN-AD-1",
      shape: "VM.Standard.A1.Flex",
      shapeConfig: { ocpus: 2, memoryInGBs: 12 },
      lifecycleState: "RUNNING",
      timeCreated: "2026-10-01T09:30:00.000Z",
      region: "us-ashburn-1",
      freeformTags: { role: "edge", env: "prod" },
      sourceDetails: {
        imageId:
          "ocid1.image.oc1.us-ashburn-1.aaaaaaaaimage0000000000000000000000000000001",
      },
    },
    {
      id: "ocid1.instance.oc1.us-ashburn-1.anuwgljrjjoracletest000000000000000000000000000002",
      displayName: "oracle-worker",
      compartmentId: childCompartmentId,
      availabilityDomain: "Uocm:US-ASHBURN-AD-2",
      shape: "VM.Standard.E4.Flex",
      shapeConfig: { ocpus: 1, memoryInGBs: 8 },
      lifecycleState: "STOPPED",
      timeCreated: "2026-10-02T10:00:00.000Z",
      region: "us-ashburn-1",
      freeformTags: { role: "worker" },
      sourceDetails: {
        imageId:
          "ocid1.image.oc1.us-ashburn-1.aaaaaaaaimage0000000000000000000000000000002",
      },
    },
  ];
  const vnics = {
    "ocid1.vnic.oc1.us-ashburn-1.aaaaaaaavnic000000000000000000000000000000000001": {
      id: "ocid1.vnic.oc1.us-ashburn-1.aaaaaaaavnic000000000000000000000000000000000001",
      instanceId: instances[0].id,
      privateIp: "10.0.1.25",
      publicIp: "129.146.88.42",
      ipv6Addresses: ["2603:c020:8002:abcd::25"],
    },
    "ocid1.vnic.oc1.us-ashburn-1.aaaaaaaavnic000000000000000000000000000000000002": {
      id: "ocid1.vnic.oc1.us-ashburn-1.aaaaaaaavnic000000000000000000000000000000000002",
      instanceId: instances[1].id,
      privateIp: "10.0.2.18",
      publicIp: "",
      ipv6Addresses: [],
    },
  };
  const requests = [];
  let invalidSignatures = 0;

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://localhost");
    const authorization = parseAuthorization(request.headers.authorization);
    const signedHeaders = String(authorization.headers || "").split(/\s+/);
    const signingParts = signedHeaders.map((header) => {
      if (header === "(request-target)") {
        return `${header}: ${request.method.toLowerCase()} ${request.url}`;
      }
      return `${header}: ${request.headers[header] || ""}`;
    });
    const expectedKeyId = `${tenancyId}/${userId}/${fingerprint}`;
    const signatureValid =
      authorization.algorithm === "rsa-sha256" &&
      authorization.keyId === expectedKeyId &&
      verify(
        "RSA-SHA256",
        Buffer.from(signingParts.join("\n"), "utf8"),
        publicKey,
        Buffer.from(authorization.signature || "", "base64"),
      );
    const bodyHashValid =
      request.method !== "POST" ||
      request.headers["x-content-sha256"] ===
        createHash("sha256").update(body).digest("base64");

    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: request.headers,
      body,
      requestUrl: request.url,
      signedHeaders,
      signingString: signingParts.join("\n"),
      signatureValid,
    });

    if (!signatureValid || !bodyHashValid) {
      invalidSignatures += 1;
      json(response, 401, {
        code: "NotAuthenticated",
        message: "The required authentication information was not provided.",
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/compartments"
    ) {
      json(response, 200, [
        {
          id: childCompartmentId,
          compartmentId: rootCompartmentId,
          name: "apps",
          lifecycleState: "ACTIVE",
        },
      ]);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/instances"
    ) {
      const compartmentId = url.searchParams.get("compartmentId");
      json(
        response,
        200,
        instances.filter(
          (instance) => instance.compartmentId === compartmentId,
        ),
      );
      return;
    }

    const actionMatch = url.pathname.match(
      /^\/20160918\/instances\/([^/]+)$/,
    );
    if (actionMatch && request.method === "POST") {
      const instanceId = decodeURIComponent(actionMatch[1]);
      const instance = instances.find((entry) => entry.id === instanceId);
      if (!instance) {
        json(response, 404, {
          code: "NotAuthorizedOrNotFound",
          message: "The instance was not found.",
        });
        return;
      }
      const action = url.searchParams.get("action");
      if (action === "STOP") {
        instance.lifecycleState = "STOPPED";
      } else if (action === "START") {
        instance.lifecycleState = "RUNNING";
      } else if (action === "RESET") {
        instance.lifecycleState = "RUNNING";
      } else {
        json(response, 400, {
          code: "InvalidParameter",
          message: "Unsupported action.",
        });
        return;
      }
      json(response, 200, instance);
      return;
    }

    if (actionMatch && request.method === "GET") {
      const instanceId = decodeURIComponent(actionMatch[1]);
      const instance = instances.find((entry) => entry.id === instanceId);
      if (!instance) {
        json(response, 404, {
          code: "NotAuthorizedOrNotFound",
          message: "The instance was not found.",
        });
        return;
      }
      json(response, 200, instance);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/vnicAttachments"
    ) {
      const instanceId = url.searchParams.get("instanceId");
      json(
        response,
        200,
        Object.values(vnics)
          .filter((vnic) => vnic.instanceId === instanceId)
          .map((vnic) => ({
            id: `${vnic.id}-attachment`,
            instanceId: vnic.instanceId,
            vnicId: vnic.id,
            lifecycleState: "ATTACHED",
          })),
      );
      return;
    }

    const vnicMatch = url.pathname.match(/^\/20160918\/vnics\/([^/]+)$/);
    if (vnicMatch && request.method === "GET") {
      const vnic = vnics[decodeURIComponent(vnicMatch[1])];
      if (!vnic) {
        json(response, 404, {
          code: "NotAuthorizedOrNotFound",
          message: "The VNIC was not found.",
        });
        return;
      }
      json(response, 200, vnic);
      return;
    }

    json(response, 404, {
      code: "NotAuthorizedOrNotFound",
      message: "The requested resource was not found.",
    });
  });

  const address = await listen(server);

  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    tenancyId,
    userId,
    compartmentId: rootCompartmentId,
    childCompartmentId,
    fingerprint,
    privateKey,
    publicKey,
    instances,
    requests,
    get invalidSignatures() {
      return invalidSignatures;
    },
    endpointResolver: ({ service }) => {
      if (!["compute", "identity"].includes(service)) {
        throw new Error(`Unexpected OCI service: ${service}`);
      }
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
