const OCI_REGION_GROUP_ORDER = [
  "亚太",
  "欧洲",
  "中东与非洲",
  "北美",
  "拉丁美洲",
];

export const OCI_REGIONS = [
  {
    id: "ap-sydney-1",
    label: "澳大利亚东部（悉尼）",
    name: "Australia East (Sydney)",
    country: "AU",
    group: "亚太",
  },
  {
    id: "ap-melbourne-1",
    label: "澳大利亚东南部（墨尔本）",
    name: "Australia Southeast (Melbourne)",
    country: "AU",
    group: "亚太",
  },
  {
    id: "sa-saopaulo-1",
    label: "巴西东部（圣保罗）",
    name: "Brazil East (Sao Paulo)",
    country: "BR",
    group: "拉丁美洲",
  },
  {
    id: "sa-vinhedo-1",
    label: "巴西东南部（维涅杜）",
    name: "Brazil Southeast (Vinhedo)",
    country: "BR",
    group: "拉丁美洲",
  },
  {
    id: "ca-montreal-1",
    label: "加拿大东南部（蒙特利尔）",
    name: "Canada Southeast (Montreal)",
    country: "CA",
    group: "北美",
  },
  {
    id: "ca-toronto-1",
    label: "加拿大东南部（多伦多）",
    name: "Canada Southeast (Toronto)",
    country: "CA",
    group: "北美",
  },
  {
    id: "sa-santiago-1",
    label: "智利中部（圣地亚哥）",
    name: "Chile Central (Santiago)",
    country: "CL",
    group: "拉丁美洲",
  },
  {
    id: "sa-valparaiso-1",
    label: "智利西部（瓦尔帕莱索）",
    name: "Chile West (Valparaiso)",
    country: "CL",
    group: "拉丁美洲",
  },
  {
    id: "sa-bogota-1",
    label: "哥伦比亚中部（波哥大）",
    name: "Colombia Central (Bogota)",
    country: "CO",
    group: "拉丁美洲",
  },
  {
    id: "eu-paris-1",
    label: "法国中部（巴黎）",
    name: "France Central (Paris)",
    country: "FR",
    group: "欧洲",
  },
  {
    id: "eu-marseille-1",
    label: "法国南部（马赛）",
    name: "France South (Marseille)",
    country: "FR",
    group: "欧洲",
  },
  {
    id: "eu-frankfurt-1",
    label: "德国中部（法兰克福）",
    name: "Germany Central (Frankfurt)",
    country: "DE",
    group: "欧洲",
  },
  {
    id: "ap-hyderabad-1",
    label: "印度南部（海得拉巴）",
    name: "India South (Hyderabad)",
    country: "IN",
    group: "亚太",
  },
  {
    id: "ap-mumbai-1",
    label: "印度西部（孟买）",
    name: "India West (Mumbai)",
    country: "IN",
    group: "亚太",
  },
  {
    id: "ap-batam-1",
    label: "印度尼西亚北部（巴淡岛）",
    name: "Indonesia North (Batam)",
    country: "ID",
    group: "亚太",
  },
  {
    id: "il-jerusalem-1",
    label: "以色列中部（耶路撒冷）",
    name: "Israel Central (Jerusalem)",
    country: "IL",
    group: "中东与非洲",
  },
  {
    id: "eu-milan-1",
    label: "意大利西北部（米兰）",
    name: "Italy Northwest (Milan)",
    country: "IT",
    group: "欧洲",
  },
  {
    id: "eu-turin-1",
    label: "意大利北部（都灵）",
    name: "Italy North (Turin)",
    country: "IT",
    group: "欧洲",
  },
  {
    id: "ap-osaka-1",
    label: "日本中部（大阪）",
    name: "Japan Central (Osaka)",
    country: "JP",
    group: "亚太",
  },
  {
    id: "ap-tokyo-1",
    label: "日本东部（东京）",
    name: "Japan East (Tokyo)",
    country: "JP",
    group: "亚太",
  },
  {
    id: "ap-kulai-2",
    label: "马来西亚西部 2（古来）",
    name: "Malaysia West 2 (Kulai)",
    country: "MY",
    group: "亚太",
  },
  {
    id: "mx-queretaro-1",
    label: "墨西哥中部（克雷塔罗）",
    name: "Mexico Central (Queretaro)",
    country: "MX",
    group: "拉丁美洲",
  },
  {
    id: "mx-monterrey-1",
    label: "墨西哥东北部（蒙特雷）",
    name: "Mexico Northeast (Monterrey)",
    country: "MX",
    group: "拉丁美洲",
  },
  {
    id: "af-casablanca-1",
    label: "摩洛哥西部（卡萨布兰卡）",
    name: "Morocco West (Casablanca)",
    country: "MA",
    group: "中东与非洲",
  },
  {
    id: "eu-amsterdam-1",
    label: "荷兰西北部（阿姆斯特丹）",
    name: "Netherlands Northwest (Amsterdam)",
    country: "NL",
    group: "欧洲",
  },
  {
    id: "me-riyadh-1",
    label: "沙特阿拉伯中部（利雅得）",
    name: "Saudi Arabia Central (Riyadh)",
    country: "SA",
    group: "中东与非洲",
  },
  {
    id: "me-jeddah-1",
    label: "沙特阿拉伯西部（吉达）",
    name: "Saudi Arabia West (Jeddah)",
    country: "SA",
    group: "中东与非洲",
  },
  {
    id: "eu-jovanovac-1",
    label: "塞尔维亚中部（约万诺瓦茨）",
    name: "Serbia Central (Jovanovac)",
    country: "RS",
    group: "欧洲",
  },
  {
    id: "ap-singapore-1",
    label: "新加坡",
    name: "Singapore (Singapore)",
    country: "SG",
    group: "亚太",
  },
  {
    id: "ap-singapore-2",
    label: "新加坡西部",
    name: "Singapore West (Singapore)",
    country: "SG",
    group: "亚太",
  },
  {
    id: "af-johannesburg-1",
    label: "南非中部（约翰内斯堡）",
    name: "South Africa Central (Johannesburg)",
    country: "ZA",
    group: "中东与非洲",
  },
  {
    id: "ap-seoul-1",
    label: "韩国中部（首尔）",
    name: "South Korea Central (Seoul)",
    country: "KR",
    group: "亚太",
  },
  {
    id: "ap-chuncheon-1",
    label: "韩国北部（春川）",
    name: "South Korea North (Chuncheon)",
    country: "KR",
    group: "亚太",
  },
  {
    id: "eu-madrid-1",
    label: "西班牙中部（马德里）",
    name: "Spain Central (Madrid)",
    country: "ES",
    group: "欧洲",
  },
  {
    id: "eu-madrid-3",
    label: "西班牙中部 3（马德里）",
    name: "Spain Central (Madrid 3)",
    country: "ES",
    group: "欧洲",
  },
  {
    id: "eu-stockholm-1",
    label: "瑞典中部（斯德哥尔摩）",
    name: "Sweden Central (Stockholm)",
    country: "SE",
    group: "欧洲",
  },
  {
    id: "eu-zurich-1",
    label: "瑞士北部（苏黎世）",
    name: "Switzerland North (Zurich)",
    country: "CH",
    group: "欧洲",
  },
  {
    id: "me-abudhabi-1",
    label: "阿联酋中部（阿布扎比）",
    name: "UAE Central (Abu Dhabi)",
    country: "AE",
    group: "中东与非洲",
  },
  {
    id: "me-dubai-1",
    label: "阿联酋东部（迪拜）",
    name: "UAE East (Dubai)",
    country: "AE",
    group: "中东与非洲",
  },
  {
    id: "uk-london-1",
    label: "英国南部（伦敦）",
    name: "UK South (London)",
    country: "GB",
    group: "欧洲",
  },
  {
    id: "uk-cardiff-1",
    label: "英国西部（纽波特）",
    name: "UK West (Newport)",
    country: "GB",
    group: "欧洲",
  },
  {
    id: "us-ashburn-1",
    label: "美国东部（阿什本）",
    name: "US East (Ashburn)",
    country: "US",
    group: "北美",
  },
  {
    id: "us-chicago-1",
    label: "美国中西部（芝加哥）",
    name: "US Midwest (Chicago)",
    country: "US",
    group: "北美",
  },
  {
    id: "us-phoenix-1",
    label: "美国西部（凤凰城）",
    name: "US West (Phoenix)",
    country: "US",
    group: "北美",
  },
  {
    id: "us-sanjose-1",
    label: "美国西部（圣何塞）",
    name: "US West (San Jose)",
    country: "US",
    group: "北美",
  },
];

const OCI_REGION_BY_ID = new Map(
  OCI_REGIONS.map((region) => [region.id, region]),
);

export function getOracleRegion(regionId) {
  const normalized = String(regionId || "")
    .trim()
    .toLowerCase();
  return OCI_REGION_BY_ID.get(normalized) || null;
}

export function oracleRegionLabel(regionId) {
  return getOracleRegion(regionId)?.label || String(regionId || "").trim();
}

export function oracleRegionOptionText(region) {
  return `${region.label} — ${region.name} — ${region.id}`;
}

export function oracleRegionGroups() {
  const groups = new Map(OCI_REGION_GROUP_ORDER.map((label) => [label, []]));

  for (const region of OCI_REGIONS) {
    groups.get(region.group)?.push(region);
  }

  return [...groups.entries()]
    .map(([label, regions]) => ({
      label,
      regions: regions
        .slice()
        .sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
    }))
    .filter((group) => group.regions.length > 0);
}
