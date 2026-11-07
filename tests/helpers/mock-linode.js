import http from "node:http";

const TOKEN = "test-linode-token";
const ALT_TOKEN = "test-linode-token-alt";

const REGIONS = [
  {
    id: "ap-south",
    label: "Singapore, SG",
    country: "sg",
    status: "ok",
    capabilities: ["Linodes", "NodeBalancers", "Block Storage", "Object Storage"],
  },
  {
    id: "ap-northeast",
    label: "Tokyo, JP",
    country: "jp",
    status: "ok",
    capabilities: ["Linodes", "NodeBalancers", "Block Storage"],
  },
  {
    id: "ap-west",
    label: "Mumbai, IN",
    country: "in",
    status: "ok",
    capabilities: ["Linodes", "Block Storage"],
  },
  {
    id: "us-east",
    label: "Newark, NJ",
    country: "us",
    status: "ok",
    capabilities: ["Linodes", "NodeBalancers", "Block Storage", "Object Storage"],
  },
  {
    id: "eu-west",
    label: "London, UK",
    country: "gb",
    status: "ok",
    capabilities: ["Linodes", "NodeBalancers", "Block Storage", "Object Storage"],
  },
];

const TYPES = [
  {
    id: "g6-nanode-1",
    label: "Nanode 1 GB",
    class: "standard",
    vcpus: 1,
    memory: 1024,
    disk: 25600,
    transfer: 1000,
    price: { hourly: 0.0075, monthly: 5 },
    addons: { backups: { price: { hourly: 0.003, monthly: 2 } } },
  },
  {
    id: "g6-standard-1",
    label: "Linode 2 GB",
    class: "standard",
    vcpus: 1,
    memory: 2048,
    disk: 51200,
    transfer: 2000,
    price: { hourly: 0.018, monthly: 12 },
    addons: { backups: { price: { hourly: 0.004, monthly: 2.5 } } },
  },
  {
    id: "g6-standard-2",
    label: "Linode 4 GB",
    class: "standard",
    vcpus: 2,
    memory: 4096,
    disk: 81920,
    transfer: 4000,
    price: { hourly: 0.036, monthly: 24 },
    addons: { backups: { price: { hourly: 0.006, monthly: 4 } } },
    region_prices: [{ id: "ap-south", hourly: 0.0432, monthly: 28.8 }],
  },
  {
    id: "g6-standard-4",
    label: "Linode 8 GB",
    class: "standard",
    vcpus: 4,
    memory: 8192,
    disk: 163840,
    transfer: 5000,
    price: { hourly: 0.072, monthly: 48 },
    addons: { backups: { price: { hourly: 0.008, monthly: 5 } } },
  },
  {
    id: "g6-standard-6",
    label: "Linode 16 GB",
    class: "standard",
    vcpus: 6,
    memory: 16384,
    disk: 327680,
    transfer: 8000,
    price: { hourly: 0.144, monthly: 96 },
    addons: { backups: { price: { hourly: 0.012, monthly: 7.5 } } },
  },
  {
    id: "g6-dedicated-2",
    label: "Dedicated 4 GB",
    class: "dedicated",
    vcpus: 2,
    memory: 4096,
    disk: 81920,
    transfer: 4000,
    price: { hourly: 0.054, monthly: 36 },
    addons: { backups: { price: { hourly: 0.006, monthly: 4 } } },
  },
  {
    id: "g6-highmem-2",
    label: "High Memory 8 GB",
    class: "highmem",
    vcpus: 2,
    memory: 8192,
    disk: 163840,
    transfer: 5000,
    price: { hourly: 0.09, monthly: 60 },
    addons: { backups: { price: { hourly: 0.008, monthly: 5 } } },
  },
  {
    id: "g1-gpu-rtx6000-1",
    label: "RTX 6000 1 GPU",
    class: "gpu",
    vcpus: 8,
    memory: 32768,
    disk: 640000,
    transfer: 12000,
    price: { hourly: 0.5, monthly: 350 },
    addons: { backups: { price: { hourly: 0.02, monthly: 12 } } },
  },
];

const IMAGE_SPECS = [
  ["linode/ubuntu24.04", "Ubuntu 24.04 LTS", "Ubuntu"],
  ["linode/ubuntu22.04", "Ubuntu 22.04 LTS", "Ubuntu"],
  ["linode/debian12", "Debian 12", "Debian"],
  ["linode/debian11", "Debian 11", "Debian"],
  ["linode/alpine3.20", "Alpine 3.20", "Alpine"],
  ["linode/rocky9", "Rocky Linux 9", "Rocky Linux"],
  ["linode/centos-stream9", "CentOS Stream 9", "CentOS"],
  ["linode/fedora40", "Fedora 40", "Fedora"],
  ["private/ops-base", "ops-base-2026.10", "私有镜像"],
];

const IMAGES = IMAGE_SPECS.map(([id, label, vendor], index) => ({
  id,
  label,
  vendor,
  created_by: index === IMAGE_SPECS.length - 1 ? "example" : "linode",
  created: "2026-01-05T08:00:00",
  deprecated: false,
  is_public: index !== IMAGE_SPECS.length - 1,
  size: 2500,
  status: "available",
  type: "manual",
}));

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeStats(seed = 1) {
  const now = Date.now();
  const points = [];
  for (let index = 0; index < 96; index += 1) {
    const timestamp = now - (95 - index) * 15 * 60_000;
    const wave = Math.sin((index + seed * 7) / 7) * 7 + Math.sin(index / 2.4) * 2;
    points.push([timestamp, Math.max(1, 15 + wave + seed * 2)]);
  }
  const netIn = points.map(([timestamp, value], index) => [
    timestamp,
    2_000_000 + value * 70_000 + Math.sin(index / 4) * 500_000,
  ]);
  const netOut = points.map(([timestamp, value], index) => [
    timestamp,
    1_100_000 + value * 44_000 + Math.cos(index / 5) * 330_000,
  ]);

  return {
    cpu: points,
    netv4: { in: netIn, out: netOut },
    netv6: { in: [], out: [] },
    io: { io: points.map(([timestamp, value]) => [timestamp, value * 130]) },
  };
}

function instanceSeed() {
  return [
    {
      id: 58120442,
      label: "pilot-edge-01",
      status: "running",
      region: "ap-south",
      type: "g6-standard-2",
      image: "linode/ubuntu24.04",
      ipv4: ["172.104.55.21", "192.168.144.12"],
      ipv6: "2400:8907::f03c:95ff:fe90:3a21/128",
      ipv6_ranges: ["2400:8907:aa01::/64"],
      specs: { disk: 81920, memory: 4096, vcpus: 2, transfer: 4000 },
      tags: ["production", "web", "edge"],
      created: "2026-08-12T09:24:00",
      updated: isoMinutesAgo(3),
      hypervisor: "kvm",
      watchdog_enabled: true,
      backups: { enabled: true, available: true, schedule: { day: "Sunday", window: "W2" }, last_successful: isoMinutesAgo(920) },
      lish: "root@lish-singapore-1.linode.com",
    },
    {
      id: 57910311,
      label: "atlas-worker",
      status: "running",
      region: "ap-northeast",
      type: "g6-dedicated-2",
      image: "linode/ubuntu22.04",
      ipv4: ["139.162.72.14"],
      ipv6: "2400:8902::f03c:95ff:fe31:2a09/128",
      specs: { disk: 81920, memory: 4096, vcpus: 2, transfer: 4000 },
      tags: ["production", "worker", "queue"],
      created: "2026-06-18T13:10:00",
      updated: isoMinutesAgo(8),
      hypervisor: "kvm",
      backups: { enabled: true, available: true, schedule: { day: "Saturday", window: "W1" }, last_successful: isoMinutesAgo(1680) },
    },
    {
      id: 56492010,
      label: "api-gateway",
      status: "running",
      region: "us-east",
      type: "g6-standard-1",
      image: "linode/debian12",
      ipv4: ["45.79.203.88"],
      ipv6: "2600:3c03::f03c:95ff:fe7a:9b32/128",
      specs: { disk: 51200, memory: 2048, vcpus: 1, transfer: 2000 },
      tags: ["production", "api"],
      created: "2026-04-02T07:44:00",
      updated: isoMinutesAgo(1),
      hypervisor: "kvm",
      backups: { enabled: false, available: false },
    },
    {
      id: 61204773,
      label: "staging-sandbox",
      status: "offline",
      region: "eu-west",
      type: "g6-nanode-1",
      image: "linode/ubuntu24.04",
      ipv4: ["176.58.113.40"],
      ipv6: "2a01:7e01::f03c:95ff:fe32:cd01/128",
      specs: { disk: 25600, memory: 1024, vcpus: 1, transfer: 1000 },
      tags: ["staging"],
      created: "2026-09-21T16:22:00",
      updated: isoMinutesAgo(490),
      hypervisor: "kvm",
      backups: { enabled: false, available: false },
    },
    {
      id: 55190332,
      label: "analytics-db",
      status: "running",
      region: "ap-south",
      type: "g6-highmem-2",
      image: "linode/debian12",
      ipv4: ["172.104.61.119"],
      ipv6: "2400:8907::f03c:95ff:fe2b:4188/128",
      ipv6_ranges: ["2400:8907:bb02::/64"],
      specs: { disk: 163840, memory: 8192, vcpus: 2, transfer: 5000 },
      tags: ["production", "database", "critical"],
      created: "2025-12-03T11:11:00",
      updated: isoMinutesAgo(12),
      hypervisor: "kvm",
      backups: { enabled: true, available: true, schedule: { day: "Daily", window: "W3" }, last_successful: isoMinutesAgo(430) },
    },
    {
      id: 49780310,
      label: "old-build-node",
      status: "offline",
      region: "us-east",
      type: "g6-standard-4",
      image: "linode/debian11",
      ipv4: ["45.79.188.54"],
      ipv6: "2600:3c03::f03c:95ff:fe44:10a1/128",
      specs: { disk: 163840, memory: 8192, vcpus: 4, transfer: 5000 },
      tags: ["ci", "deprecated"],
      created: "2025-03-15T05:35:00",
      updated: isoMinutesAgo(3200),
      hypervisor: "kvm",
      backups: { enabled: false, available: false },
    },
  ];
}

const EVENTS = [
  {
    id: 9832012,
    action: "linode_boot",
    created: isoMinutesAgo(3),
    status: "finished",
    entity: { id: 58120442, label: "pilot-edge-01", type: "linode" },
    username: "ops",
    duration: 34,
  },
  {
    id: 9829011,
    action: "linode_config_update",
    created: isoMinutesAgo(72),
    status: "finished",
    entity: { id: 58120442, label: "pilot-edge-01", type: "linode" },
    username: "ops",
    duration: 1,
  },
  {
    id: 9825310,
    action: "backup_restore",
    created: isoMinutesAgo(410),
    status: "finished",
    entity: { id: 55190332, label: "analytics-db", type: "linode" },
    username: "ops",
    duration: 182,
  },
  {
    id: 9823204,
    action: "linode_shutdown",
    created: isoMinutesAgo(490),
    status: "finished",
    entity: { id: 61204773, label: "staging-sandbox", type: "linode" },
    username: "ops",
    duration: 20,
  },
  {
    id: 9812012,
    action: "linode_reboot",
    created: isoMinutesAgo(920),
    status: "finished",
    entity: { id: 57910311, label: "atlas-worker", type: "linode" },
    username: "ops",
    duration: 61,
  },
  {
    id: 9798211,
    action: "disk_resize",
    created: isoMinutesAgo(1520),
    status: "failed",
    entity: { id: 49780310, label: "old-build-node", type: "linode" },
    username: "ops",
    message: "Not enough space in the region",
    duration: 2,
  },
];

const ALT_ACCOUNT = {
  first_name: "Rina",
  last_name: "Sato",
  company: "Orbit Works",
  email: "rina@orbit.example",
  balance: 12.5,
  balance_uninvoiced: 1.25,
  active_since: "2025-01-15T00:00:00",
  billing_source: "account",
  country: "JP",
};

const ALT_TRANSFER = {
  billable: 2,
  used: 50,
  quota: 1000,
};

function altInstanceSeed() {
  return [
    {
      id: 72000001,
      label: "tokyo-batch",
      status: "running",
      region: "ap-northeast",
      type: "g6-standard-1",
      image: "linode/debian12",
      ipv4: ["139.162.88.41"],
      ipv6: "2400:8902::f03c:95ff:fe55:1a01/128",
      specs: { disk: 51200, memory: 2048, vcpus: 1, transfer: 2000 },
      tags: ["batch", "tokyo"],
      created: "2026-02-11T08:30:00",
      updated: isoMinutesAgo(18),
      hypervisor: "kvm",
      backups: { enabled: false, available: false },
    },
    {
      id: 72000002,
      label: "osaka-archive",
      status: "offline",
      region: "ap-south",
      type: "g6-nanode-1",
      image: "linode/alpine3.20",
      ipv4: ["172.104.71.90"],
      ipv6: "2400:8907::f03c:95ff:fe22:7b02/128",
      specs: { disk: 25600, memory: 1024, vcpus: 1, transfer: 1000 },
      tags: ["archive"],
      created: "2025-11-20T04:12:00",
      updated: isoMinutesAgo(1440),
      hypervisor: "kvm",
      backups: { enabled: false, available: false },
    },
  ];
}

const ALT_EVENTS = [
  {
    id: 9900001,
    action: "linode_create",
    created: isoMinutesAgo(30),
    status: "finished",
    entity: { id: 72000001, label: "tokyo-batch", type: "linode" },
    username: "rina",
    duration: 42,
  },
  {
    id: 9900002,
    action: "linode_shutdown",
    created: isoMinutesAgo(1500),
    status: "finished",
    entity: { id: 72000002, label: "osaka-archive", type: "linode" },
    username: "rina",
    duration: 19,
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPrivateIpv4(address) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
    String(address || ""),
  );
}

function normalizeIpv6Range(value) {
  return String(value || "").trim();
}

function buildMockIpInfo(instance) {
  const publicAddresses = (instance.ipv4 || []).filter(
    (address) => !isPrivateIpv4(address),
  );
  const privateAddresses = (instance.ipv4 || []).filter(isPrivateIpv4);
  const toIpv4Record = (address, isPublic) => ({
    address,
    gateway: isPublic ? `${address.split(".").slice(0, 3).join(".")}.1` : null,
    linode_id: instance.id,
    prefix: 24,
    public: isPublic,
    rdns: isPublic ? `${address}.ip.linodeusercontent.com` : null,
    region: instance.region,
    subnet_mask: "255.255.255.0",
    type: "ipv4",
  });
  const ranges = (instance.ipv6_ranges || [])
    .map((value) => {
      const range = normalizeIpv6Range(value);
      const [base, prefixValue] = range.split("/");
      const prefix = Number(prefixValue);
      if (!base || ![56, 64].includes(prefix)) {
        return null;
      }
      return {
        prefix,
        range: base,
        region: instance.region,
        route_target: String(instance.ipv6 || "").replace(/\/\d+$/, ""),
      };
    })
    .filter(Boolean);

  return {
    ipv4: {
      private: privateAddresses.map((address) => toIpv4Record(address, false)),
      public: publicAddresses.map((address) => toIpv4Record(address, true)),
      reserved: [],
      shared: [],
      vpc: [],
    },
    ipv6: {
      global: ranges,
      link_local: {
        address: "fe80::1",
        gateway: "fe80::2",
        linode_id: instance.id,
        prefix: 64,
        public: false,
        region: instance.region,
        type: "ipv6",
      },
      slaac: {
        address: String(instance.ipv6 || "").replace(/\/\d+$/, ""),
        gateway: "fe80::2",
        linode_id: instance.id,
        prefix: 128,
        public: true,
        region: instance.region,
        type: "ipv6",
      },
    },
  };
}

export async function createMockLinode({ port = 0 } = {}) {
  const accountStates = new Map([
    [
      TOKEN,
      {
        account: {
          first_name: "Ming",
          last_name: "Chen",
          company: "Northstar Labs",
          email: "ops@northstar.example",
          balance: 42.18,
          balance_uninvoiced: 7.34,
          active_since: "2024-05-01T00:00:00",
          billing_source: "account",
          country: "SG",
        },
        transfer: {
          billable: 4,
          used: 183.4,
          quota: 5000,
        },
        instances: instanceSeed(),
        events: clone(EVENTS),
      },
    ],
    [
      ALT_TOKEN,
      {
        account: clone(ALT_ACCOUNT),
        transfer: clone(ALT_TRANSFER),
        instances: altInstanceSeed(),
        events: clone(ALT_EVENTS),
      },
    ],
  ]);
  const requests = [];
  let nextId = 62000000;
  let nextExtraIpv4 = 10;
  let nextIpv6Range = 3;
  let failNextIpv6RangeCreate = false;
  let failNextIpv6RangeDelete = false;
  let failNextIpDelete = false;
  let failNextIpv4Create = false;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(/^\/v4/, "");
    requests.push({
      method: request.method,
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: request.headers,
      body: ["POST", "PUT", "PATCH"].includes(request.method)
        ? await readBody(request)
        : null,
    });

    const authorization = String(request.headers.authorization || "");
    const accountState = accountStates.get(
      authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "",
    );
    if (!accountState) {
      return json(response, 401, {
        errors: [{ reason: "Invalid Token" }],
      });
    }

    const pageSize = Number(url.searchParams.get("page_size"));
    if (
      url.searchParams.has("page_size") &&
      (!Number.isFinite(pageSize) || pageSize < 25 || pageSize > 500)
    ) {
      return json(response, 400, {
        errors: [{ field: "page_size", reason: "Must be 25-500" }],
      });
    }

    if (path === "/account" && request.method === "GET") {
      return json(response, 200, clone(accountState.account));
    }

    if (path === "/account/transfer" && request.method === "GET") {
      return json(response, 200, clone(accountState.transfer));
    }

    if (path === "/account/events" && request.method === "GET") {
      return json(response, 200, {
        data: clone(accountState.events),
        page: 1,
        pages: 1,
        results: accountState.events.length,
      });
    }

    if (path === "/regions" && request.method === "GET") {
      return json(response, 200, {
        data: clone(REGIONS),
        page: 1,
        pages: 1,
        results: REGIONS.length,
      });
    }

    if (path === "/linode/types" && request.method === "GET") {
      return json(response, 200, {
        data: clone(TYPES),
        page: 1,
        pages: 1,
        results: TYPES.length,
      });
    }

    if (path === "/images" && request.method === "GET") {
      return json(response, 200, {
        data: clone(IMAGES),
        page: 1,
        pages: 1,
        results: IMAGES.length,
      });
    }

    const availabilityMatch = path.match(/^\/regions\/([^/]+)\/availability$/);
    if (availabilityMatch && request.method === "GET") {
      const region = availabilityMatch[1];
      return json(
        response,
        200,
        TYPES.map((type) => ({
          region,
          plan: type.id,
          available:
            type.class !== "gpu" || ["us-east", "ap-northeast"].includes(region),
        })),
      );
    }

    if (path === "/linode/instances" && request.method === "GET") {
      return json(response, 200, {
        data: clone(accountState.instances),
        page: 1,
        pages: 1,
        results: accountState.instances.length,
      });
    }

    if (path === "/linode/instances" && request.method === "POST") {
      const body = requests[requests.length - 1].body || {};
      const plan = TYPES.find((type) => type.id === body.type) || TYPES[0];
      const newInstance = {
        id: nextId++,
        label: body.label || `linode-${nextId}`,
        status: body.booted === false ? "offline" : "running",
        region: body.region,
        type: body.type,
        image: body.image,
        ipv4: [`172.104.77.${Math.floor(Math.random() * 200) + 20}`],
        ipv6: "2400:8907::f03c:95ff:fe55:90a1/128",
        specs: {
          disk: plan.disk,
          memory: plan.memory,
          vcpus: plan.vcpus,
          transfer: plan.transfer,
        },
        tags: body.tags || [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        hypervisor: "kvm",
        backups: { enabled: Boolean(body.backups_enabled), available: false },
      };
      accountState.instances = [newInstance, ...accountState.instances];
      return json(response, 200, newInstance);
    }

    const statsMatch = path.match(/^\/linode\/instances\/(\d+)\/stats$/);
    if (statsMatch && request.method === "GET") {
      return json(response, 200, makeStats(Number(statsMatch[1]) % 9));
    }

    const backupsMatch = path.match(/^\/linode\/instances\/(\d+)\/backups$/);
    if (backupsMatch && request.method === "GET") {
      const instance = accountState.instances.find(
        (entry) => entry.id === Number(backupsMatch[1]),
      );
      return json(
        response,
        200,
        instance?.backups || {
          enabled: false,
          available: false,
        },
      );
    }

    const ipsMatch = path.match(/^\/linode\/instances\/(\d+)\/ips$/);
    if (ipsMatch) {
      const instance = accountState.instances.find(
        (entry) => entry.id === Number(ipsMatch[1]),
      );
      if (!instance) {
        return json(response, 404, {
          errors: [{ reason: "Not found" }],
        });
      }
      if (request.method === "GET") {
        return json(response, 200, buildMockIpInfo(instance));
      }
      if (request.method === "POST") {
        if (failNextIpv4Create) {
          failNextIpv4Create = false;
          return json(response, 500, {
            errors: [{ reason: "Mock additional IPv4 allocation failed" }],
          });
        }
        const body = requests[requests.length - 1].body || {};
        if (body.type !== "ipv4" || body.public !== true) {
          return json(response, 400, {
            errors: [
              {
                field: "type",
                reason: "Only public IPv4 allocations are supported",
              },
            ],
          });
        }

        let address;
        do {
          address = `172.104.90.${nextExtraIpv4++}`;
        } while (
          [...accountStates.values()].some((state) =>
            state.instances.some((entry) => entry.ipv4.includes(address)),
          )
        );
        instance.ipv4.push(address);
        return json(
          response,
          200,
          buildMockIpInfo(instance).ipv4.public.find(
            (entry) => entry.address === address,
          ),
        );
      }
    }

    if (path === "/networking/ips/assign" && request.method === "POST") {
      const body = requests[requests.length - 1].body || {};
      if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
        return json(response, 400, {
          errors: [{ field: "assignments", reason: "Assignments are required" }],
        });
      }
      if (
        accountState.instances.some(
          (instance) =>
            instance.region !== body.region &&
            body.assignments.some(
              (assignment) => assignment.linode_id === instance.id,
            ),
        )
      ) {
        return json(response, 400, {
          errors: [{ field: "region", reason: "All resources must be in one region" }],
        });
      }

      const ipv4Assignments = body.assignments.filter(
        (assignment) => !String(assignment.address || "").includes(":"),
      );
      const ipv6Assignments = body.assignments.filter((assignment) =>
        String(assignment.address || "").includes(":"),
      );

      for (const assignment of ipv4Assignments) {
        for (const instance of accountState.instances) {
          instance.ipv4 = instance.ipv4.filter(
            (address) => address !== assignment.address,
          );
        }
      }
      for (const assignment of ipv4Assignments) {
        const instance = accountState.instances.find(
          (entry) => entry.id === assignment.linode_id,
        );
        if (!instance) {
          return json(response, 404, {
            errors: [{ reason: "Linode not found" }],
          });
        }
        if (!instance.ipv4.includes(assignment.address)) {
          instance.ipv4.push(assignment.address);
        }
        instance.ipv4.sort(
          (left, right) => Number(isPrivateIpv4(left)) - Number(isPrivateIpv4(right)),
        );
        if (!instance.ipv4.some((address) => !isPrivateIpv4(address))) {
          return json(response, 400, {
            errors: [
              {
                field: "assignments",
                reason: "Each Linode must keep at least one public IPv4 address",
              },
            ],
          });
        }
      }

      const rangeAssignments = ipv6Assignments.map((assignment) => ({
        ...assignment,
        address: normalizeIpv6Range(assignment.address),
      }));
      for (const assignment of rangeAssignments) {
        for (const instance of accountState.instances) {
          instance.ipv6_ranges = (instance.ipv6_ranges || []).filter(
            (range) => normalizeIpv6Range(range) !== assignment.address,
          );
        }
      }
      for (const assignment of rangeAssignments) {
        const instance = accountState.instances.find(
          (entry) => entry.id === assignment.linode_id,
        );
        if (!instance) {
          return json(response, 404, {
            errors: [{ reason: "Linode not found" }],
          });
        }
        instance.ipv6_ranges = instance.ipv6_ranges || [];
        if (!instance.ipv6_ranges.includes(assignment.address)) {
          instance.ipv6_ranges.push(assignment.address);
        }
      }

      return json(response, 200, {});
    }

    const instanceIpDeleteMatch = path.match(
      /^\/linode\/instances\/(\d+)\/ips\/([^/]+)$/,
    );
    if (instanceIpDeleteMatch && request.method === "DELETE") {
      const instance = accountState.instances.find(
        (entry) => entry.id === Number(instanceIpDeleteMatch[1]),
      );
      if (!instance) {
        return json(response, 404, {
          errors: [{ reason: "Not found" }],
        });
      }
      if (failNextIpDelete) {
        failNextIpDelete = false;
        return json(response, 500, {
          errors: [{ reason: "Mock IPv4 deletion failed" }],
        });
      }
      const address = decodeURIComponent(instanceIpDeleteMatch[2]);
      if (!instance.ipv4.includes(address)) {
        return json(response, 404, {
          errors: [{ reason: "IP address not found on this Linode" }],
        });
      }
      const remaining = instance.ipv4.filter((entry) => entry !== address);
      if (!remaining.some((entry) => !isPrivateIpv4(entry))) {
        return json(response, 400, {
          errors: [
            {
              reason: "A Linode must keep at least one public IPv4 address",
            },
          ],
        });
      }
      instance.ipv4 = remaining;
      return json(response, 200, {});
    }

    if (path === "/networking/ipv6/ranges" && request.method === "POST") {
      if (failNextIpv6RangeCreate) {
        failNextIpv6RangeCreate = false;
        return json(response, 500, {
          errors: [{ reason: "Mock IPv6 range creation failed" }],
        });
      }

      const body = requests[requests.length - 1].body || {};
      const instance = accountState.instances.find(
        (entry) => entry.id === Number(body.linode_id),
      );
      if (!instance) {
        return json(response, 404, {
          errors: [{ reason: "Linode not found" }],
        });
      }

      const prefix = Number(body.prefix_length);
      if (![56, 64].includes(prefix)) {
        return json(response, 400, {
          errors: [
            {
              field: "prefix_length",
              reason: "Prefix length must be 56 or 64",
            },
          ],
        });
      }

      const base = `2400:8907:${(0xcc00 + nextIpv6Range++).toString(16)}::`;
      instance.ipv6_ranges = instance.ipv6_ranges || [];
      instance.ipv6_ranges.push(`${base}/${prefix}`);
      return json(response, 200, {
        prefix,
        range: base,
        region: instance.region,
        route_target: String(instance.ipv6 || "").replace(/\/\d+$/, ""),
      });
    }

    const ipv6RangeDeleteMatch = path.match(
      /^\/networking\/ipv6\/ranges\/(.+)$/,
    );
    if (ipv6RangeDeleteMatch && request.method === "DELETE") {
      if (failNextIpv6RangeDelete) {
        failNextIpv6RangeDelete = false;
        return json(response, 500, {
          errors: [{ reason: "Mock IPv6 range deletion failed" }],
        });
      }
      let range;
      try {
        range = decodeURIComponent(ipv6RangeDeleteMatch[1]);
      } catch {
        return json(response, 400, {
          errors: [{ reason: "Invalid IPv6 range" }],
        });
      }
      const rangeAddress = normalizeIpv6Range(range).split("/")[0];
      for (const instance of accountState.instances) {
        instance.ipv6_ranges = (instance.ipv6_ranges || []).filter(
          (entry) =>
            normalizeIpv6Range(entry).split("/")[0] !== rangeAddress,
        );
      }
      return json(response, 200, {});
    }

    const actionMatch = path.match(
      /^\/linode\/instances\/(\d+)\/(boot|shutdown|reboot)$/,
    );
    if (actionMatch && request.method === "POST") {
      const instance = accountState.instances.find(
        (entry) => entry.id === Number(actionMatch[1]),
      );
      if (!instance) {
        return json(response, 404, {
          errors: [{ reason: "Not found" }],
        });
      }
      if (actionMatch[2] === "shutdown") instance.status = "offline";
      if (actionMatch[2] === "boot" || actionMatch[2] === "reboot") {
        instance.status = "running";
      }
      instance.updated = new Date().toISOString();
      return json(response, 200, {});
    }

    const instanceMatch = path.match(/^\/linode\/instances\/(\d+)$/);
    if (instanceMatch) {
      const instance = accountState.instances.find(
        (entry) => entry.id === Number(instanceMatch[1]),
      );
      if (!instance) {
        return json(response, 404, {
          errors: [{ reason: "Not found" }],
        });
      }
      if (request.method === "GET") {
        return json(response, 200, clone(instance));
      }
      if (request.method === "DELETE") {
        accountState.instances = accountState.instances.filter(
          (entry) => entry.id !== instance.id,
        );
        return json(response, 200, {});
      }
    }

    return json(response, 404, {
      errors: [{ reason: `Unhandled mock route: ${request.method} ${path}` }],
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();

  return {
    token: TOKEN,
    altToken: ALT_TOKEN,
    apiBase: `http://127.0.0.1:${address.port}/v4`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
    server,
    setInstanceIpv4(instanceId, addresses) {
      for (const state of accountStates.values()) {
        const instance = state.instances.find(
          (entry) => entry.id === Number(instanceId),
        );
        if (!instance) {
          continue;
        }
        instance.ipv4 = Array.isArray(addresses)
          ? addresses.map((value) => String(value))
          : [];
        return;
      }
      throw new Error(`Mock instance ${instanceId} was not found.`);
    },
    setFailNextIpv6RangeCreate(value = true) {
      failNextIpv6RangeCreate = Boolean(value);
    },
    setFailNextIpv6RangeDelete(value = true) {
      failNextIpv6RangeDelete = Boolean(value);
    },
    setFailNextIpDelete(value = true) {
      failNextIpDelete = Boolean(value);
    },
    setFailNextIpv4Create(value = true) {
      failNextIpv4Create = Boolean(value);
    },
    setInstanceStatus(instanceId, status) {
      for (const state of accountStates.values()) {
        const instance = state.instances.find(
          (entry) => entry.id === Number(instanceId),
        );
        if (!instance) {
          continue;
        }
        instance.status = String(status);
        return;
      }
      throw new Error(`Mock instance ${instanceId} was not found.`);
    },
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

if (process.argv[1]?.endsWith("mock-linode.js")) {
  const mock = await createMockLinode({ port: Number(process.env.MOCK_PORT || 4300) });
  console.log(`Mock Linode API: ${mock.apiBase}`);
  console.log(`Token: ${mock.token}`);
}
