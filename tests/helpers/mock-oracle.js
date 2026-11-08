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

function text(response, status, payload, extraHeaders = {}) {
  const body = String(payload);
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function empty(response, status = 204) {
  response.writeHead(status, {
    "content-length": "0",
  });
  response.end();
}

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function ocid(kind, region, suffix) {
  const tail = `${String(suffix).padEnd(60, "0")}`.slice(0, 60);
  return `ocid1.${kind}.oc1.${region}.${tail}`;
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
  const availabilityDomains = [
    { name: "Uocm:US-ASHBURN-AD-1", compartmentId: tenancyId },
    { name: "Uocm:US-ASHBURN-AD-2", compartmentId: tenancyId },
    { name: "Uocm:US-ASHBURN-AD-3", compartmentId: tenancyId },
  ];
  const shapes = [
    {
      shape: "VM.Standard.A1.Flex",
      processorDescription: "Ampere Altra",
      ocpuOptions: [{ min: 1, max: 4 }],
      memoryOptions: [{ minInGBs: 6, maxInGBs: 24 }],
      isFlexible: true,
    },
    {
      shape: "VM.Standard.E4.Flex",
      processorDescription: "AMD EPYC",
      ocpuOptions: [{ min: 1, max: 4 }],
      memoryOptions: [{ minInGBs: 1, maxInGBs: 64 }],
      isFlexible: true,
    },
    {
      shape: "VM.Standard.E2.1.Micro",
      processorDescription: "AMD EPYC",
      ocpus: 1,
      memoryInGBs: 1,
      isFlexible: false,
    },
  ];
  const images = [
    {
      id: ocid("image", "us-ashburn-1", "aaaaaaaaimage0000000000000000000000000000000001"),
      displayName: "Oracle Linux 9",
      operatingSystem: "Oracle Linux",
      operatingSystemVersion: "9",
      lifecycleState: "AVAILABLE",
      sizeInGBs: 50,
      timeCreated: "2026-09-01T00:00:00.000Z",
      compartmentId: rootCompartmentId,
    },
    {
      id: ocid("image", "us-ashburn-1", "aaaaaaaaimage0000000000000000000000000000000002"),
      displayName: "Canonical Ubuntu 24.04",
      operatingSystem: "Canonical Ubuntu",
      operatingSystemVersion: "24.04",
      lifecycleState: "AVAILABLE",
      sizeInGBs: 50,
      timeCreated: "2026-09-01T00:00:00.000Z",
      compartmentId: rootCompartmentId,
    },
    {
      id: ocid(
        "image",
        "us-ashburn-1",
        "aaaaaaaaimage0000000000000000000000000000000003",
      ),
      displayName: "Custom Ubuntu 24.04",
      operatingSystem: "Canonical Ubuntu",
      operatingSystemVersion: "24.04",
      lifecycleState: "AVAILABLE",
      sizeInGBs: 80,
      timeCreated: "2026-10-15T00:00:00.000Z",
      compartmentId: childCompartmentId,
    },
  ];
  const vcnId = ocid(
    "vcn",
    "us-ashburn-1",
    "aaaaaaaavcn0000000000000000000000000000000000001",
  );
  const vcns = [
    {
      id: vcnId,
      displayName: "oci-vcn",
      cidrBlock: "10.0.0.0/16",
      lifecycleState: "AVAILABLE",
      compartmentId: rootCompartmentId,
    },
  ];
  const subnetId = ocid(
    "subnet",
    "us-ashburn-1",
    "aaaaaaaasubnet000000000000000000000000000000001",
  );
  const subnets = [
    {
      id: subnetId,
      displayName: "public-subnet",
      vcnId,
      cidrBlock: "10.0.1.0/24",
      lifecycleState: "AVAILABLE",
      prohibitPublicIpOnVnic: false,
      compartmentId: rootCompartmentId,
    },
  ];
  const bootVolumes = {
    [ocid("bootvolume", "us-ashburn-1", "aaaaaaaabootvolume00000000000000000000000000001")]:
      {
        id: ocid(
          "bootvolume",
          "us-ashburn-1",
          "aaaaaaaabootvolume00000000000000000000000000001",
        ),
        displayName: "oracle-edge-boot",
        sizeInGBs: 50,
        lifecycleState: "ATTACHED",
        availabilityDomain: instances[0].availabilityDomain,
        compartmentId: instances[0].compartmentId,
        instanceId: instances[0].id,
      },
    [ocid("bootvolume", "us-ashburn-1", "aaaaaaaabootvolume00000000000000000000000000002")]:
      {
        id: ocid(
          "bootvolume",
          "us-ashburn-1",
          "aaaaaaaabootvolume00000000000000000000000000002",
        ),
        displayName: "oracle-worker-boot",
        sizeInGBs: 50,
        lifecycleState: "ATTACHED",
        availabilityDomain: instances[1].availabilityDomain,
        compartmentId: instances[1].compartmentId,
        instanceId: instances[1].id,
      },
  };
  const bootVolumeAttachments = Object.values(bootVolumes).map((volume) => ({
    id: ocid(
      "bootvolumeattachment",
      "us-ashburn-1",
      `${volume.id.slice(-46)}-attachment`,
    ),
    instanceId: volume.instanceId,
    bootVolumeId: volume.id,
    lifecycleState: "ATTACHED",
    availabilityDomain: volume.availabilityDomain,
    compartmentId: volume.compartmentId,
  }));
  const backups = [
    {
      id: ocid(
        "bootvolumebackup",
        "us-ashburn-1",
        "aaaaaaaabootbackup000000000000000000000000000001",
      ),
      bootVolumeId: bootVolumes[
        ocid(
          "bootvolume",
          "us-ashburn-1",
          "aaaaaaaabootvolume00000000000000000000000000001",
        )
      ].id,
      displayName: "oracle-edge-manual",
      lifecycleState: "AVAILABLE",
      type: "INCREMENTAL",
      sizeInGBs: 50,
      uniqueSizeInGBs: 8,
      timeCreated: "2026-11-01T03:00:00.000Z",
      expirationTime: null,
    },
  ];
  const consoleConnections = [
    {
      id: ocid(
        "instanceconsoleconnection",
        "us-ashburn-1",
        "aaaaaaaaconsoleconnection00000000000000000000001",
      ),
      instanceId: instances[0].id,
      lifecycleState: "ACTIVE",
      connectionString:
        "ssh -o ProxyCommand='ssh -W %h:%p -p 443 ocid1.instanceconsoleconnection.oc1.us-ashburn-1.example' -i <private_key_file> <serial_console_host>",
      vncConnectionString:
        "ssh -o ProxyCommand='ssh -W %h:%p -p 443 ocid1.instanceconsoleconnection.oc1.us-ashburn-1.example' -i <private_key_file> <vnc_console_host>",
      fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
      serviceHostKeyFingerprint: "SHA256:mock-console-host-key",
      timeCreated: "2026-11-02T04:00:00.000Z",
    },
  ];
  const consoleHistories = [
    {
      id: ocid(
        "instanceconsolehistory",
        "us-ashburn-1",
        "aaaaaaaaconsolehistory000000000000000000000001",
      ),
      instanceId: instances[0].id,
      displayName: "oracle-edge-boot-log",
      lifecycleState: "AVAILABLE",
      timeCreated: "2026-11-02T04:10:00.000Z",
    },
  ];
  const consoleHistoryData = [
    "Oracle Linux Server boot log",
    "Loading Linux kernel...",
    "Started serial console login service.",
    "oracle-edge login:",
  ].join("\n");
  const created = [];
  const requests = [];
  let invalidSignatures = 0;
  let bootBackupSequence = backups.length;
  let consoleConnectionSequence = consoleConnections.length;
  let consoleHistorySequence = consoleHistories.length;
  let createSequence = 0;

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
      !["POST", "PUT", "PATCH"].includes(request.method) ||
      !request.headers["x-content-sha256"] ||
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
      request.method === "POST" &&
      url.pathname === "/20180401/metrics/actions/summarizeMetricsData"
    ) {
      const query = parseJson(body);
      const queryText = String(query.query || "");
      const namespace = String(query.namespace || "oci_computeagent");
      const metricName = [
        "CpuUtilization",
        "MemoryUtilization",
        "LoadAverage",
        "NetworksBytesIn",
        "NetworksBytesOut",
        "DiskBytesRead",
        "DiskBytesWritten",
      ].find((name) => queryText.includes(name));
      if (!metricName) {
        json(response, 200, []);
        return;
      }
      const metricValues = {
        CpuUtilization: 12,
        MemoryUtilization: 40,
        LoadAverage: 1.4,
        NetworksBytesIn: 1_100_000,
        NetworksBytesOut: 780_000,
        DiskBytesRead: 48_000,
        DiskBytesWritten: 32_000,
      };
      const startTime = new Date(query.startTime || Date.now());
      const endTime = new Date(query.endTime || Date.now());
      const span = Math.max(endTime.getTime() - startTime.getTime(), 1);
      const points = Array.from({ length: 12 }, (_, index) => ({
        timestamp: new Date(
          startTime.getTime() + (span * index) / 11,
        ).toISOString(),
        value: metricValues[metricName] + index * (metricName === "CpuUtilization" ? 2.5 : 1),
      }));
      json(response, 200, [
        {
          namespace,
          compartmentId: url.searchParams.get("compartmentId"),
          name: metricName,
          dimensions: {
            resourceId:
              queryText.match(/resourceId\s*=\s*"([^"]+)"/)?.[1] || "",
          },
          resolution: query.resolution || "5m",
          aggregatedDatapoints: points,
        },
      ]);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/availabilityDomains"
    ) {
      json(response, 200, availabilityDomains);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/shapes"
    ) {
      json(response, 200, shapes);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/images"
    ) {
      const compartmentId = url.searchParams.get("compartmentId");
      json(
        response,
        200,
        images.filter(
          (image) =>
            !compartmentId || image.compartmentId === compartmentId,
        ),
      );
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/vcns"
    ) {
      json(response, 200, vcns);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/subnets"
    ) {
      json(
        response,
        200,
        subnets.filter(
          (subnet) => subnet.compartmentId === url.searchParams.get("compartmentId"),
        ),
      );
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/bootVolumeAttachments"
    ) {
      const instanceId = url.searchParams.get("instanceId");
      const compartmentId = url.searchParams.get("compartmentId");
      json(
        response,
        200,
        bootVolumeAttachments.filter(
          (attachment) =>
            (!instanceId || attachment.instanceId === instanceId) &&
            (!compartmentId || attachment.compartmentId === compartmentId),
        ),
      );
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/20160918/bootVolumeBackups"
    ) {
      const bootVolumeId = url.searchParams.get("bootVolumeId");
      json(
        response,
        200,
        backups.filter(
          (backup) => !bootVolumeId || backup.bootVolumeId === bootVolumeId,
        ),
      );
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/20160918/bootVolumeBackups"
    ) {
      const input = parseJson(body);
      const volume = bootVolumes[input.bootVolumeId];
      if (!volume) {
        json(response, 404, {
          code: "NotAuthorizedOrNotFound",
          message: "The boot volume was not found.",
        });
        return;
      }
      bootBackupSequence += 1;
      const backup = {
        id: ocid(
          "bootvolumebackup",
          "us-ashburn-1",
          `aaaaaaaabootbackup0000000000000000000000000000${bootBackupSequence}`,
        ),
        bootVolumeId: volume.id,
        displayName: input.displayName || `manual-backup-${bootBackupSequence}`,
        lifecycleState: "CREATING",
        type: input.type === "FULL" ? "FULL" : "INCREMENTAL",
        sizeInGBs: volume.sizeInGBs,
        uniqueSizeInGBs: 0,
        timeCreated: new Date().toISOString(),
        expirationTime: null,
      };
      backups.push(backup);
      json(response, 200, backup);
      return;
    }

    const bootVolumeBackupMatch = url.pathname.match(
      /^\/20160918\/bootVolumeBackups\/([^/]+)$/,
    );
    if (bootVolumeBackupMatch) {
      const backupId = decodeURIComponent(bootVolumeBackupMatch[1]);
      const index = backups.findIndex((backup) => backup.id === backupId);
      if (request.method === "GET") {
        if (index < 0) {
          json(response, 404, {
            code: "NotAuthorizedOrNotFound",
            message: "The boot volume backup was not found.",
          });
          return;
        }
        json(response, 200, backups[index]);
        return;
      }
      if (request.method === "DELETE") {
        if (index < 0) {
          json(response, 404, {
            code: "NotAuthorizedOrNotFound",
            message: "The boot volume backup was not found.",
          });
          return;
        }
        backups.splice(index, 1);
        empty(response, 204);
        return;
      }
    }

    const bootVolumeMatch = url.pathname.match(
      /^\/20160918\/bootVolumes\/([^/]+)$/,
    );
    if (bootVolumeMatch && request.method === "GET") {
      const volume = bootVolumes[decodeURIComponent(bootVolumeMatch[1])];
      if (!volume) {
        json(response, 404, {
          code: "NotAuthorizedOrNotFound",
          message: "The boot volume was not found.",
        });
        return;
      }
      json(response, 200, volume);
      return;
    }

    if (
      url.pathname === "/20160918/instanceConsoleConnections" &&
      ["GET", "POST"].includes(request.method)
    ) {
      if (request.method === "POST") {
        const input = parseJson(body);
        consoleConnectionSequence += 1;
        const connection = {
          id: ocid(
            "instanceconsoleconnection",
            "us-ashburn-1",
            `aaaaaaaaconsoleconnection0000000000000000000000${consoleConnectionSequence}`,
          ),
          instanceId: input.instanceId,
          lifecycleState: "ACTIVE",
          connectionString:
            "ssh -o ProxyCommand='ssh -W %h:%p -p 443 ocid1.instanceconsoleconnection.oc1.us-ashburn-1.example' -i <private_key_file> <serial_console_host>",
          vncConnectionString:
            "ssh -o ProxyCommand='ssh -W %h:%p -p 443 ocid1.instanceconsoleconnection.oc1.us-ashburn-1.example' -i <private_key_file> <vnc_console_host>",
          fingerprint: fingerprintFor(publicKey),
          serviceHostKeyFingerprint: "SHA256:mock-console-host-key",
          publicKey: input.publicKey,
          timeCreated: new Date().toISOString(),
        };
        consoleConnections.push(connection);
        json(response, 200, connection);
        return;
      }
      const instanceId = url.searchParams.get("instanceId");
      json(
        response,
        200,
        consoleConnections.filter(
          (connection) => !instanceId || connection.instanceId === instanceId,
        ),
      );
      return;
    }

    const consoleConnectionMatch = url.pathname.match(
      /^\/20160918\/instanceConsoleConnections\/([^/]+)$/,
    );
    if (consoleConnectionMatch) {
      const connectionId = decodeURIComponent(consoleConnectionMatch[1]);
      const index = consoleConnections.findIndex(
        (connection) => connection.id === connectionId,
      );
      if (request.method === "GET") {
        if (index < 0) {
          json(response, 404, {
            code: "NotAuthorizedOrNotFound",
            message: "The console connection was not found.",
          });
          return;
        }
        json(response, 200, consoleConnections[index]);
        return;
      }
      if (request.method === "DELETE") {
        if (index < 0) {
          json(response, 404, {
            code: "NotAuthorizedOrNotFound",
            message: "The console connection was not found.",
          });
          return;
        }
        consoleConnections.splice(index, 1);
        empty(response, 204);
        return;
      }
    }

    if (
      url.pathname === "/20160918/instanceConsoleHistories" &&
      ["GET", "POST"].includes(request.method)
    ) {
      if (request.method === "POST") {
        const input = parseJson(body);
        consoleHistorySequence += 1;
        const history = {
          id: ocid(
            "instanceconsolehistory",
            "us-ashburn-1",
            `aaaaaaaaconsolehistory0000000000000000000000${consoleHistorySequence}`,
          ),
          instanceId: input.instanceId,
          displayName: input.displayName || `console-history-${consoleHistorySequence}`,
          lifecycleState: "AVAILABLE",
          timeCreated: new Date().toISOString(),
        };
        consoleHistories.push(history);
        json(response, 200, history);
        return;
      }
      const instanceId = url.searchParams.get("instanceId");
      json(
        response,
        200,
        consoleHistories.filter(
          (history) => !instanceId || history.instanceId === instanceId,
        ),
      );
      return;
    }

    const consoleHistoryDataMatch = url.pathname.match(
      /^\/20160918\/instanceConsoleHistories\/([^/]+)\/data$/,
    );
    if (consoleHistoryDataMatch && request.method === "GET") {
      const historyId = decodeURIComponent(consoleHistoryDataMatch[1]);
      if (!consoleHistories.some((history) => history.id === historyId)) {
        json(response, 404, {
          code: "NotAuthorizedOrNotFound",
          message: "The console history was not found.",
        });
        return;
      }
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const length = Math.max(
        0,
        Number(url.searchParams.get("length")) || consoleHistoryData.length,
      );
      text(
        response,
        200,
        consoleHistoryData.slice(offset, offset + length),
      );
      return;
    }

    const consoleHistoryMatch = url.pathname.match(
      /^\/20160918\/instanceConsoleHistories\/([^/]+)$/,
    );
    if (consoleHistoryMatch) {
      const historyId = decodeURIComponent(consoleHistoryMatch[1]);
      const index = consoleHistories.findIndex(
        (history) => history.id === historyId,
      );
      if (request.method === "GET") {
        if (index < 0) {
          json(response, 404, {
            code: "NotAuthorizedOrNotFound",
            message: "The console history was not found.",
          });
          return;
        }
        json(response, 200, consoleHistories[index]);
        return;
      }
      if (request.method === "DELETE") {
        if (index < 0) {
          json(response, 404, {
            code: "NotAuthorizedOrNotFound",
            message: "The console history was not found.",
          });
          return;
        }
        consoleHistories.splice(index, 1);
        empty(response, 204);
        return;
      }
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

    if (
      request.method === "POST" &&
      url.pathname === "/20160918/instances"
    ) {
      const input = parseJson(body);
      createSequence += 1;
      const instance = {
        ...input,
        id: ocid(
          "instance",
          "us-ashburn-1",
          `aaaaaaaainstance0000000000000000000000000000000${createSequence}`,
        ),
        region: "us-ashburn-1",
        lifecycleState: "PROVISIONING",
        timeCreated: new Date().toISOString(),
        freeformTags: {},
        shapeConfig: input.shapeConfig || {
          ocpus: 1,
          memoryInGBs: 1,
        },
        sourceDetails: input.sourceDetails || {
          imageId: input.imageId,
        },
      };
      instances.push(instance);
      created.push(instance);
      json(response, 200, instance);
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

    if (actionMatch && request.method === "DELETE") {
      const instanceId = decodeURIComponent(actionMatch[1]);
      const index = instances.findIndex((entry) => entry.id === instanceId);
      if (index < 0) {
        json(response, 404, {
          code: "NotAuthorizedOrNotFound",
          message: "The instance was not found.",
        });
        return;
      }
      instances.splice(index, 1);
      empty(response, 204);
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
    created,
    backups,
    bootVolumes,
    bootVolumeAttachments,
    consoleConnections,
    consoleHistories,
    consoleHistoryData,
    availabilityDomains,
    shapes,
    images,
    vcns,
    subnets,
    requests,
    get invalidSignatures() {
      return invalidSignatures;
    },
    endpointResolver: ({ service }) => {
      if (
        ![
          "compute",
          "identity",
          "monitoring",
          "network",
          "block-storage",
        ].includes(service)
      ) {
        throw new Error(`Unexpected OCI service: ${service}`);
      }
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
