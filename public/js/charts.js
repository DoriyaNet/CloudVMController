let chartCounter = 0;

export function extractPoints(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const rawPoints = [];
  const visit = (node) => {
    if (!Array.isArray(node)) {
      return;
    }
    if (
      node.length >= 2 &&
      typeof node[0] === "number" &&
      typeof node[1] === "number"
    ) {
      rawPoints.push([node[0] < 10_000_000_000 ? node[0] * 1000 : node[0], node[1]]);
      return;
    }
    node.forEach(visit);
  };

  visit(value);
  if (rawPoints.length === 0) {
    return [];
  }

  const grouped = new Map();
  for (const [timestamp, pointValue] of rawPoints) {
    const entry = grouped.get(timestamp) || { total: 0, count: 0 };
    entry.total += pointValue;
    entry.count += 1;
    grouped.set(timestamp, entry);
  }

  return [...grouped.entries()]
    .map(([timestamp, entry]) => [timestamp, entry.total / entry.count])
    .sort((left, right) => left[0] - right[0]);
}

export function latestValue(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }
  return points[points.length - 1][1];
}

function buildSeriesPath(points, bounds, width, height, padding) {
  if (!points.length) {
    return "";
  }

  const [minTime, maxTime, maxValue] = bounds;
  const timeSpan = Math.max(maxTime - minTime, 1);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  return points
    .map(([timestamp, value], index) => {
      const x = padding.left + ((timestamp - minTime) / timeSpan) * innerWidth;
      const y =
        padding.top +
        innerHeight -
        (Math.max(0, value) / Math.max(maxValue, 1)) * innerHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function renderLineChart(series, options = {}) {
  const {
    height = 150,
    colors = ["#42e294", "#63b3ed"],
    fill = true,
    maxValueOverride = null,
  } = options;

  const chartId = `chart-${chartCounter += 1}`;
  const width = 640;
  const padding = { top: 12, right: 8, bottom: 10, left: 8 };
  const normalized = series.map((entry) => ({
    ...entry,
    points: extractPoints(entry.points),
  }));
  const allPoints = normalized.flatMap((entry) => entry.points);

  if (allPoints.length === 0) {
    return `<div class="chart-empty">暂无监控数据</div>`;
  }

  const minTime = Math.min(...allPoints.map((point) => point[0]));
  const maxTime = Math.max(...allPoints.map((point) => point[0]));
  const observedMax = Math.max(...allPoints.map((point) => point[1]), 1);
  const maxValue =
    maxValueOverride === null
      ? observedMax * 1.15
      : Math.max(maxValueOverride, 1);
  const bounds = [minTime, maxTime, maxValue];

  const gridLines = [0.25, 0.5, 0.75]
    .map((ratio) => {
      const y = padding.top + (height - padding.top - padding.bottom) * ratio;
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" />`;
    })
    .join("");

  const paths = normalized
    .map((entry, index) => {
      const linePath = buildSeriesPath(
        entry.points,
        bounds,
        width,
        height,
        padding,
      );
      if (!linePath) {
        return "";
      }

      const color = colors[index % colors.length];
      const lastPoint = entry.points[entry.points.length - 1];
      const lastX =
        padding.left +
        ((lastPoint[0] - minTime) / Math.max(maxTime - minTime, 1)) *
          (width - padding.left - padding.right);
      const lastY =
        padding.top +
        (height - padding.top - padding.bottom) -
        (Math.max(0, lastPoint[1]) / Math.max(maxValue, 1)) *
          (height - padding.top - padding.bottom);

      return `
        ${
          fill
            ? `<path class="chart-area" d="${linePath} L${lastX.toFixed(2)},${(height - padding.bottom).toFixed(2)} L${padding.left},${(height - padding.bottom).toFixed(2)} Z" fill="url(#${chartId}-${index})"></path>`
            : ""
        }
        <path class="chart-line" d="${linePath}" stroke="${color}"></path>
        <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="3.2" fill="${color}" class="chart-dot"></circle>
      `;
    })
    .join("");

  const gradients = normalized
    .map((_, index) => {
      const color = colors[index % colors.length];
      return `
        <linearGradient id="${chartId}-${index}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.22"></stop>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>
        </linearGradient>
      `;
    })
    .join("");

  return `
    <svg
      class="line-chart"
      viewBox="0 0 ${width} ${height}"
      preserveAspectRatio="none"
      role="img"
      aria-label="资源监控曲线"
    >
      <defs>${gradients}</defs>
      <g class="chart-grid">${gridLines}</g>
      <g>${paths}</g>
    </svg>
  `;
}
