/**
 * ModelFitInsightCard — Tier 2 Insight
 *
 * Condition: ollama_model_size_gb != null (model is loaded)
 * Dismissable per session.
 *
 * Severity:
 *   poor  → red border  (close to Tier 1 urgency, but still dismissable)
 *   good / fair → amber border
 *
 * Renders the existing ModelFitCard content inside InsightCard using the
 * bare prop to skip the double-container nesting.
 */

import React from 'react';
import type { SentinelMetrics } from '../../../types';
import { computeModelFitScore } from '../../../utils/modelFit';
import InsightCard from '../InsightCard';
import ModelFitCard from '../ModelFitCard';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  node:            SentinelMetrics;
  showNodeHeader?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

const ModelFitInsightCard: React.FC<Props> = ({ node, showNodeHeader = false }) => {
  const result = computeModelFitScore(node);

  // Guard: no model loaded or insufficient data
  if (!result) return null;

  const severity = result.score === 'poor' ? 'red' : 'amber';

  return (
    <InsightCard
      id="model-fit"
      nodeId={node.node_id}
      tier={2}
      severity={severity}
      title="Model Fit Score"
    >
      {/*
       * ModelFitCard with bare=true skips its outer div wrapper so it
       * composes cleanly inside InsightCard without double borders or nesting.
       */}
      <ModelFitCard
        result={result}
        node={node}
        showNodeHeader={showNodeHeader}
        bare
      />
    </InsightCard>
  );
};

export default ModelFitInsightCard;
