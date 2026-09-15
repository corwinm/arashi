export interface DurationSummary {
  medianMs: number;
  p95Ms: number;
  samplesMs: number[];
}

export function summarizeDurations(samples: number[]): DurationSummary {
  if (samples.length === 0) {
    throw new Error("Benchmark timing requires at least one measured sample.");
  }

  const samplesMs = [...samples].toSorted((left, right) => left - right);
  const middle = Math.floor(samplesMs.length / 2);
  const medianMs =
    samplesMs.length % 2 === 0
      ? (samplesMs[middle - 1]! + samplesMs[middle]!) / 2
      : samplesMs[middle]!;
  const p95Index = Math.ceil(samplesMs.length * 0.95) - 1;

  return { medianMs, p95Ms: samplesMs[p95Index]!, samplesMs };
}
