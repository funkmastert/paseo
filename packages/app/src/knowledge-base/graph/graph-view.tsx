import { useCallback, useMemo, type ReactElement } from "react";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import type { Theme } from "@/styles/theme";
import type { KnowledgeGraphLayout, KnowledgeGraphPositionedNode } from "./graph-layout-model";

const NODE_RADIUS = 10;
/** 44pt touch target (docs/design.md), as a transparent circle layered over the visible node. */
const HIT_RADIUS = 22;
const LABEL_MAX_CHARS = 16;
const LABEL_OFFSET_Y = NODE_RADIUS + 14;
const SELECTED_RING_RADIUS = NODE_RADIUS + 4;

const ThemedLine = withUnistyles(Line);
const ThemedCircle = withUnistyles(Circle);
const ThemedRing = withUnistyles(Circle);
const ThemedLabel = withUnistyles(SvgText);

const edgeColorMapping = (theme: Theme) => ({ stroke: theme.colors.border });
const labelColorMapping = (theme: Theme) => ({ fill: theme.colors.foregroundMuted });
const selectedRingMapping = (theme: Theme) => ({ stroke: theme.colors.primary });

const PROJECT_FILL_MAPPING = (theme: Theme) => ({ fill: theme.colors.primary });
const INBOX_FILL_MAPPING = (theme: Theme) => ({ fill: theme.colors.accent });
const NOTE_FILL_MAPPING = (theme: Theme) => ({ fill: theme.colors.foregroundMuted });

function nodeFillMapping(noteType: string): (theme: Theme) => { fill: string } {
  if (noteType === "project") return PROJECT_FILL_MAPPING;
  if (noteType === "inbox") return INBOX_FILL_MAPPING;
  return NOTE_FILL_MAPPING;
}

function truncateLabel(title: string): string {
  if (title.length <= LABEL_MAX_CHARS) return title;
  return `${title.slice(0, LABEL_MAX_CHARS - 1)}…`;
}

export interface KnowledgeGraphViewProps {
  layout: KnowledgeGraphLayout;
  selectedPath: string | null;
  onSelectNode: (path: string) => void;
}

/**
 * The graph (U9, KTD-11): every note, styled by type, inside the shared zoomable viewport, which
 * already supplies pan/pinch/wheel zoom and the zoom in/out/reset buttons on every platform.
 */
export function KnowledgeGraphView({
  layout,
  selectedPath,
  onSelectNode,
}: KnowledgeGraphViewProps): ReactElement {
  const { t } = useTranslation();
  const { nodes, edges, width, height } = layout;
  const contentSize = useMemo(() => ({ width, height }), [width, height]);
  const byPath = useMemo(() => new Map(nodes.map((node) => [node.path, node])), [nodes]);
  return (
    <ZoomableViewport
      accessibilityLabel={t("knowledgeBase.graph.label")}
      contentSize={contentSize}
      testID="knowledge-graph-viewport"
    >
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {edges.map((edge) => {
          const source = byPath.get(edge.source);
          const target = byPath.get(edge.target);
          if (!source || !target) return null;
          return (
            <ThemedLine
              key={`${edge.source}->${edge.target}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              uniProps={edgeColorMapping}
              strokeWidth={1}
            />
          );
        })}
        {nodes.map((node) => (
          <GraphNode
            key={node.path}
            node={node}
            selected={node.path === selectedPath}
            onSelect={onSelectNode}
          />
        ))}
      </Svg>
    </ZoomableViewport>
  );
}

function GraphNode({
  node,
  selected,
  onSelect,
}: {
  node: KnowledgeGraphPositionedNode;
  selected: boolean;
  onSelect: (path: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(node.path), [node.path, onSelect]);
  const label = truncateLabel(node.title);
  return (
    <>
      <Circle
        cx={node.x}
        cy={node.y}
        r={HIT_RADIUS}
        fill="transparent"
        onPress={handlePress}
        accessible
        accessibilityLabel={node.title}
        testID={`knowledge-graph-node-${node.path}`}
      />
      {selected ? (
        <ThemedRing
          cx={node.x}
          cy={node.y}
          r={SELECTED_RING_RADIUS}
          fill="none"
          uniProps={selectedRingMapping}
          strokeWidth={2}
        />
      ) : null}
      <ThemedCircle
        cx={node.x}
        cy={node.y}
        r={NODE_RADIUS}
        uniProps={nodeFillMapping(node.noteType)}
      />
      <ThemedLabel
        x={node.x}
        y={node.y + LABEL_OFFSET_Y}
        fontSize={11}
        textAnchor="middle"
        uniProps={labelColorMapping}
      >
        {label}
      </ThemedLabel>
    </>
  );
}
