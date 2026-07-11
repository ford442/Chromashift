interface PerformanceSparklineProps {
  values: readonly number[];
  budgetMs: number;
  width?: number;
  height?: number;
  stroke?: string;
  budgetStroke?: string;
}

export function PerformanceSparkline({
  values,
  budgetMs,
  width = 160,
  height = 36,
  stroke = '#34d399',
  budgetStroke = 'rgba(244, 63, 94, 0.55)',
}: PerformanceSparklineProps) {
  if (values.length === 0) {
    return (
      <svg width={width} height={height} className="opacity-40">
        <text x={4} y={height / 2 + 3} className="fill-cyan-200/50 text-[9px] font-mono">
          waiting…
        </text>
      </svg>
    );
  }

  const maxVal = Math.max(budgetMs * 1.25, ...values, 0.001);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = i * step;
    const y = height - (v / maxVal) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');
  const budgetY = height - (budgetMs / maxVal) * (height - 4) - 2;

  return (
    <svg width={width} height={height} className="block">
      <line
        x1={0}
        y1={budgetY}
        x2={width}
        y2={budgetY}
        stroke={budgetStroke}
        strokeDasharray="3 3"
        strokeWidth={1}
      />
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        points={points}
      />
    </svg>
  );
}
