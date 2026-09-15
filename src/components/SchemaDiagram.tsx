import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { Table, Relationship } from '../services/geminiService';
import { 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  RotateCcw, 
  Search, 
  Sparkles,
  Layers,
  Table as TableIcon
} from 'lucide-react';

interface SchemaDiagramProps {
  tables: Table[];
  relationships: Relationship[];
}

interface NodeData extends Table {
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
}

interface LinkData {
  id: string;
  source: NodeData;
  target: NodeData;
  rel: Relationship;
  sourceFieldIdx: number;
  targetFieldIdx: number;
}

const TABLE_WIDTH = 250;
const FIELD_HEIGHT = 28;
const HEADER_HEIGHT = 42;
const COL_WIDTH = 370;

const ACCENT_COLORS = [
  '#4f46e5', // indigo
  '#059669', // emerald
  '#d97706', // amber
  '#7c3aed', // violet
  '#0284c7', // sky
  '#e11d48', // rose
];

export const SchemaDiagram: React.FC<SchemaDiagramProps> = ({ tables, relationships }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTooltip, setActiveTooltip] = useState<{
    x: number;
    y: number;
    title: string;
    detail: string;
    joinSql: string;
  } | null>(null);
  const [activeHoverField, setActiveHoverField] = useState<{ table: string; field: string } | null>(null);
  const [activeHoverLink, setActiveHoverLink] = useState<string | null>(null);

  // Compute topological hierarchy levels so parent tables sit on the left, child tables on the right
  const initialNodes = useMemo(() => {
    if (!tables || tables.length === 0) return [];

    const tableMap = new Map<string, Table>();
    tables.forEach((t) => tableMap.set(t.name, t));

    // Calculate dependencies (which tables does each table reference?)
    const dependencies = new Map<string, Set<string>>();
    tables.forEach((t) => {
      const deps = new Set<string>();
      t.fields.forEach((f) => {
        if (f.isForeignKey && f.references?.table && f.references.table !== t.name) {
          deps.add(f.references.table);
        }
      });
      dependencies.set(t.name, deps);
    });

    // Multi-pass level resolver
    const levels = new Map<string, number>();
    tables.forEach((t) => levels.set(t.name, 0));

    for (let pass = 0; pass < 6; pass++) {
      tables.forEach((t) => {
        const deps = dependencies.get(t.name);
        if (deps && deps.size > 0) {
          let maxParentLevel = 0;
          deps.forEach((parent) => {
            maxParentLevel = Math.max(maxParentLevel, levels.get(parent) ?? 0);
          });
          levels.set(t.name, Math.max(levels.get(t.name) ?? 0, maxParentLevel + 1));
        }
      });
    }

    // Group tables by level
    const levelColumns = new Map<number, Table[]>();
    tables.forEach((t) => {
      const lvl = levels.get(t.name) ?? 0;
      if (!levelColumns.has(lvl)) levelColumns.set(lvl, []);
      levelColumns.get(lvl)!.push(t);
    });

    const startX = 60;
    const startY = 60;

    return tables.map((t) => {
      const lvl = levels.get(t.name) ?? 0;
      const columnTables = levelColumns.get(lvl) || [t];
      const indexInCol = columnTables.indexOf(t);
      const height = HEADER_HEIGHT + t.fields.length * FIELD_HEIGHT + 10;

      let prevHeights = 0;
      for (let i = 0; i < indexInCol; i++) {
        const prevT = columnTables[i];
        prevHeights += HEADER_HEIGHT + prevT.fields.length * FIELD_HEIGHT + 10 + 40;
      }

      return {
        ...t,
        x: startX + lvl * COL_WIDTH,
        y: startY + prevHeights,
        width: TABLE_WIDTH,
        height,
        level: lvl,
      };
    });
  }, [tables]);

  // Keep live node coordinates in a mutable ref for continuous dragging and updates
  const nodesRef = useRef<NodeData[]>([]);
  useEffect(() => {
    nodesRef.current = JSON.parse(JSON.stringify(initialNodes));
  }, [initialNodes]);

  // Main D3 Rendering
  useEffect(() => {
    if (!svgRef.current || !tables || tables.length === 0) return;

    try {
      const svg = d3.select(svgRef.current);
      svg.selectAll('*').remove();

      // Definitions (filters, arrowheads, markers)
      const defs = svg.append('defs');

      // Glow filter for highlighted links
      const filter = defs.append('filter')
        .attr('id', 'link-glow')
        .attr('x', '-20%')
        .attr('y', '-20%')
        .attr('width', '140%')
        .attr('height', '140%');
      filter.append('feGaussianBlur')
        .attr('stdDeviation', '3')
        .attr('result', 'blur');
      filter.append('feComposite')
        .attr('in', 'SourceGraphic')
        .attr('in2', 'blur')
        .attr('operator', 'over');

      // Subtle drop shadow for table cards
      const shadow = defs.append('filter')
        .attr('id', 'card-shadow')
        .attr('x', '-10%')
        .attr('y', '-10%')
        .attr('width', '130%')
        .attr('height', '130%');
      shadow.append('feDropShadow')
        .attr('dx', '0')
        .attr('dy', '4')
        .attr('stdDeviation', '6')
        .attr('flood-color', '#0f172a')
        .attr('flood-opacity', '0.06');

      // Arrowhead marker for foreign key direction
      defs.append('marker')
        .attr('id', 'erd-arrow')
        .attr('viewBox', '0 0 10 10')
        .attr('refX', '8')
        .attr('refY', '5')
        .attr('markerWidth', '6')
        .attr('markerHeight', '6')
        .attr('orient', 'auto-start-reverse')
        .append('path')
        .attr('d', 'M 0 1.5 L 8 5 L 0 8.5 z')
        .attr('fill', '#6366f1');

      // Primary Key circle marker (1-side)
      defs.append('marker')
        .attr('id', 'erd-one-dot')
        .attr('viewBox', '0 0 8 8')
        .attr('refX', '4')
        .attr('refY', '4')
        .attr('markerWidth', '6')
        .attr('markerHeight', '6')
        .append('circle')
        .attr('cx', '4')
        .attr('cy', '4')
        .attr('r', '3')
        .attr('fill', '#f59e0b');

      // Zoom container
      const g = svg.append('g').attr('class', 'canvas-group');

      const zoom = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 2.5])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });

      zoomBehaviorRef.current = zoom;
      svg.call(zoom);

      const nodes = nodesRef.current;

      // Build link structures with exact field offsets
      const links: LinkData[] = (relationships || [])
        .map((rel, idx) => {
          const source = nodes.find((n) => n.name === rel.fromTable); // child table with FK
          const target = nodes.find((n) => n.name === rel.toTable); // parent table with PK
          if (!source || !target) return null;

          const sourceFieldIdx = source.fields.findIndex((f) => f.name === rel.fromField);
          const targetFieldIdx = target.fields.findIndex((f) => f.name === rel.toField);

          return {
            id: `link-${rel.fromTable}-${rel.fromField}-${rel.toTable}-${rel.toField}-${idx}`,
            source,
            target,
            rel,
            sourceFieldIdx: sourceFieldIdx >= 0 ? sourceFieldIdx : 0,
            targetFieldIdx: targetFieldIdx >= 0 ? targetFieldIdx : 0,
          };
        })
        .filter((l): l is LinkData => Boolean(l));

      // Link Lines Layer
      const linksLayer = g.append('g').attr('class', 'links-layer');

      // Render Bezier Paths for relationships
      const linkGroups = linksLayer.selectAll('.link-group')
        .data(links, (d: any) => d.id)
        .enter()
        .append('g')
        .attr('class', 'link-group cursor-pointer');

      // Invisible thick stroke for easy hovering
      const linkHitAreas = linkGroups.append('path')
        .attr('class', 'link-hit-area')
        .attr('fill', 'none')
        .attr('stroke', 'transparent')
        .attr('stroke-width', 18);

      // Visible styled connection path
      const linkPaths = linkGroups.append('path')
        .attr('class', 'link-path')
        .attr('fill', 'none')
        .attr('stroke', '#94a3b8')
        .attr('stroke-width', 1.75)
        .attr('stroke-dasharray', (d) => d.rel.type === 'one-to-one' ? '4 2' : 'none');

      // Link badges (1:N or 1:1 indicator along path)
      const linkBadges = linkGroups.append('g')
        .attr('class', 'link-badge')
        .style('opacity', 0.85);

      linkBadges.append('rect')
        .attr('width', 36)
        .attr('height', 16)
        .attr('rx', 8)
        .attr('fill', '#ffffff')
        .attr('stroke', '#cbd5e1')
        .attr('stroke-width', 1);

      linkBadges.append('text')
        .attr('x', 18)
        .attr('y', 11.5)
        .attr('text-anchor', 'middle')
        .attr('font-size', '9px')
        .attr('font-weight', '700')
        .attr('fill', '#475569')
        .text((d) => (d.rel.type === 'one-to-one' ? '1 : 1' : '1 : N'));

      // Link interaction handlers
      linkGroups
        .on('mouseenter', function (event, d) {
          setActiveHoverLink(d.id);
          setActiveHoverField({ table: d.rel.fromTable, field: d.rel.fromField });
          
          d3.select(this).select('.link-path')
            .attr('stroke', '#6366f1')
            .attr('stroke-width', 3)
            .attr('filter', 'url(#link-glow)');

          // Highlight connected rows
          highlightFieldRow(d.rel.fromTable, d.rel.fromField, true);
          highlightFieldRow(d.rel.toTable, d.rel.toField, true);

          const containerRect = containerRef.current?.getBoundingClientRect();
          const mouseX = event.clientX - (containerRect?.left ?? 0);
          const mouseY = event.clientY - (containerRect?.top ?? 0);

          setActiveTooltip({
            x: mouseX,
            y: mouseY,
            title: `${d.rel.fromTable}.${d.rel.fromField} ➔ ${d.rel.toTable}.${d.rel.toField}`,
            detail: `Cardinality: ${d.rel.type === 'one-to-one' ? 'One-to-One' : 'One-to-Many'}`,
            joinSql: `JOIN ${d.rel.toTable} ON ${d.rel.fromTable}.${d.rel.fromField} = ${d.rel.toTable}.${d.rel.toField}`,
          });
        })
        .on('mouseleave', function (_event, d) {
          setActiveHoverLink(null);
          setActiveHoverField(null);
          setActiveTooltip(null);

          d3.select(this).select('.link-path')
            .attr('stroke', '#94a3b8')
            .attr('stroke-width', 1.75)
            .attr('filter', null);

          highlightFieldRow(d.rel.fromTable, d.rel.fromField, false);
          highlightFieldRow(d.rel.toTable, d.rel.toField, false);
        });

      // Table Nodes Layer
      const tablesLayer = g.append('g').attr('class', 'tables-layer');

      const tableGroups = tablesLayer.selectAll('.table-node')
        .data(nodes, (d: any) => d.name)
        .enter()
        .append('g')
        .attr('class', 'table-node cursor-grab')
        .attr('id', (d) => `table-${d.name}`)
        .attr('transform', (d) => `translate(${d.x}, ${d.y})`)
        .call(
          d3.drag<SVGGElement, NodeData>()
            .on('start', function () {
              d3.select(this).raise().classed('cursor-grabbing', true);
            })
            .on('drag', function (event, d) {
              d.x = event.x;
              d.y = event.y;
              d3.select(this).attr('transform', `translate(${d.x}, ${d.y})`);
              updateLinks();
            })
            .on('end', function () {
              d3.select(this).classed('cursor-grabbing', false);
            })
        );

      // Card Background with Rounded Corners & Subtle Border
      tableGroups.append('rect')
        .attr('class', 'card-body')
        .attr('width', TABLE_WIDTH)
        .attr('height', (d) => d.height)
        .attr('rx', 10)
        .attr('fill', '#ffffff')
        .attr('stroke', '#e2e8f0')
        .attr('stroke-width', 1.2)
        .attr('filter', 'url(#card-shadow)');

      // Top Accent Line with Domain Level Color
      tableGroups.append('rect')
        .attr('width', TABLE_WIDTH)
        .attr('height', 4)
        .attr('rx', 2)
        .attr('fill', (d) => ACCENT_COLORS[d.level % ACCENT_COLORS.length]);

      // Header Container
      const headers = tableGroups.append('g')
        .attr('class', 'table-header')
        .attr('transform', 'translate(0, 4)');

      headers.append('rect')
        .attr('width', TABLE_WIDTH)
        .attr('height', HEADER_HEIGHT - 4)
        .attr('fill', '#f8fafc');

      headers.append('line')
        .attr('x1', 0)
        .attr('y1', HEADER_HEIGHT - 4)
        .attr('x2', TABLE_WIDTH)
        .attr('y2', HEADER_HEIGHT - 4)
        .attr('stroke', '#e2e8f0')
        .attr('stroke-width', 1);

      // Table Icon Dot
      headers.append('circle')
        .attr('cx', 18)
        .attr('cy', (HEADER_HEIGHT - 4) / 2)
        .attr('r', 4)
        .attr('fill', (d) => ACCENT_COLORS[d.level % ACCENT_COLORS.length]);

      // Table Name in Header
      headers.append('text')
        .attr('x', 30)
        .attr('y', (HEADER_HEIGHT - 4) / 2 + 4.5)
        .attr('font-size', '13px')
        .attr('font-weight', '700')
        .attr('fill', '#0f172a')
        .attr('letter-spacing', '-0.01em')
        .text((d) => d.name);

      // Table Field Count Pill
      const badgeG = headers.append('g')
        .attr('transform', `translate(${TABLE_WIDTH - 58}, ${(HEADER_HEIGHT - 4) / 2 - 9})`);

      badgeG.append('rect')
        .attr('width', 46)
        .attr('height', 18)
        .attr('rx', 9)
        .attr('fill', '#e2e8f0');

      badgeG.append('text')
        .attr('x', 23)
        .attr('y', 12.5)
        .attr('text-anchor', 'middle')
        .attr('font-size', '9.5px')
        .attr('font-weight', '700')
        .attr('fill', '#475569')
        .text((d) => `${d.fields.length} cols`);

      // Fields Container
      const fieldsContainer = tableGroups.append('g')
        .attr('class', 'fields-container')
        .attr('transform', `translate(0, ${HEADER_HEIGHT})`);

      // Render Individual Field Rows
      tableGroups.each(function (tableData) {
        const tableGroup = d3.select(this);
        const fieldsG = tableGroup.select('.fields-container');

        tableData.fields.forEach((field, fieldIdx) => {
          const rowY = fieldIdx * FIELD_HEIGHT;

          const row = fieldsG.append('g')
            .attr('class', `field-row field-row-${tableData.name}-${field.name}`)
            .attr('transform', `translate(0, ${rowY})`);

          // Hover / Active Highlight Background
          row.append('rect')
            .attr('class', 'field-bg')
            .attr('width', TABLE_WIDTH)
            .attr('height', FIELD_HEIGHT)
            .attr('fill', 'transparent')
            .attr('transition', 'fill 0.15s ease');

          // Left Port Dot (Connector anchor)
          row.append('circle')
            .attr('class', 'port-dot port-left')
            .attr('cx', 0)
            .attr('cy', FIELD_HEIGHT / 2)
            .attr('r', 3)
            .attr('fill', '#ffffff')
            .attr('stroke', field.isPrimaryKey ? '#f59e0b' : field.isForeignKey ? '#6366f1' : '#cbd5e1')
            .attr('stroke-width', 1.5);

          // Right Port Dot (Connector anchor)
          row.append('circle')
            .attr('class', 'port-dot port-right')
            .attr('cx', TABLE_WIDTH)
            .attr('cy', FIELD_HEIGHT / 2)
            .attr('r', 3)
            .attr('fill', '#ffffff')
            .attr('stroke', field.isPrimaryKey ? '#f59e0b' : field.isForeignKey ? '#6366f1' : '#cbd5e1')
            .attr('stroke-width', 1.5);

          // Key Icon (🔑 for PK, 🔗 for FK)
          if (field.isPrimaryKey) {
            row.append('text')
              .attr('x', 10)
              .attr('y', FIELD_HEIGHT / 2 + 4.5)
              .attr('font-size', '11px')
              .text('🔑');
          } else if (field.isForeignKey) {
            row.append('text')
              .attr('x', 10)
              .attr('y', FIELD_HEIGHT / 2 + 4.5)
              .attr('font-size', '11px')
              .text('🔗');
          }

          // Field Name
          row.append('text')
            .attr('x', field.isPrimaryKey || field.isForeignKey ? 26 : 14)
            .attr('y', FIELD_HEIGHT / 2 + 4.5)
            .attr('font-size', '11.5px')
            .attr('font-weight', field.isPrimaryKey ? '700' : field.isForeignKey ? '600' : '400')
            .attr('fill', field.isPrimaryKey ? '#0f172a' : field.isForeignKey ? '#312e81' : '#475569')
            .text(field.name);

          // Field Type Badge
          const typeBadgeText = field.type.length > 12 ? field.type.slice(0, 11) + '…' : field.type;
          const typeG = row.append('g')
            .attr('transform', `translate(${TABLE_WIDTH - 12}, ${FIELD_HEIGHT / 2})`);

          typeG.append('text')
            .attr('text-anchor', 'end')
            .attr('y', 4)
            .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
            .attr('font-size', '9.5px')
            .attr('font-weight', '500')
            .attr('fill', getTypeColor(field.type))
            .text(typeBadgeText);

          // Hover interaction on field row
          row
            .on('mouseenter', function () {
              d3.select(this).select('.field-bg').attr('fill', '#f1f5f9');
              if (field.isForeignKey || field.isPrimaryKey) {
                highlightAttachedLinks(tableData.name, field.name, true);
              }
            })
            .on('mouseleave', function () {
              d3.select(this).select('.field-bg').attr('fill', 'transparent');
              if (field.isForeignKey || field.isPrimaryKey) {
                highlightAttachedLinks(tableData.name, field.name, false);
              }
            });
        });
      });

      // Helper function to highlight specific field row
      function highlightFieldRow(tableName: string, fieldName: string, highlight: boolean) {
        const row = d3.select(`.field-row-${tableName}-${fieldName}`);
        if (!row.empty()) {
          row.select('.field-bg').attr('fill', highlight ? '#e0e7ff' : 'transparent');
          row.selectAll('.port-dot')
            .attr('r', highlight ? 4.5 : 3)
            .attr('stroke', highlight ? '#4f46e5' : '#cbd5e1')
            .attr('stroke-width', highlight ? 2 : 1.5);
        }
      }

      // Highlight links attached to a field
      function highlightAttachedLinks(tableName: string, fieldName: string, highlight: boolean) {
        linkGroups.each(function (d) {
          const isSourceMatch = d.rel.fromTable === tableName && d.rel.fromField === fieldName;
          const isTargetMatch = d.rel.toTable === tableName && d.rel.toField === fieldName;

          if (isSourceMatch || isTargetMatch) {
            d3.select(this).select('.link-path')
              .attr('stroke', highlight ? '#4f46e5' : '#94a3b8')
              .attr('stroke-width', highlight ? 3 : 1.75)
              .attr('filter', highlight ? 'url(#link-glow)' : null);

            highlightFieldRow(d.rel.fromTable, d.rel.fromField, highlight);
            highlightFieldRow(d.rel.toTable, d.rel.toField, highlight);
          }
        });
      }

      // Smooth Bezier Curve link updater
      function updateLinks() {
        linkGroups.each(function (d) {
          const source = d.source; // child table
          const target = d.target; // parent table

          // Exact vertical row positions
          const sy = source.y + HEADER_HEIGHT + d.sourceFieldIdx * FIELD_HEIGHT + FIELD_HEIGHT / 2;
          const ty = target.y + HEADER_HEIGHT + d.targetFieldIdx * FIELD_HEIGHT + FIELD_HEIGHT / 2;

          // Determine connection ports (left vs right)
          let sx = source.x;
          let tx = target.x;
          let sourceDx = -60;
          let targetDx = 60;

          if (source.x + TABLE_WIDTH + 20 < target.x) {
            // Source is to the left of Target: source.right -> target.left
            sx = source.x + TABLE_WIDTH;
            tx = target.x;
            sourceDx = Math.max((tx - sx) * 0.45, 50);
            targetDx = -sourceDx;
          } else if (target.x + TABLE_WIDTH + 20 < source.x) {
            // Target is to the left of Source: source.left -> target.right
            sx = source.x;
            tx = target.x + TABLE_WIDTH;
            sourceDx = -Math.max((sx - tx) * 0.45, 50);
            targetDx = -sourceDx;
          } else {
            // Roughly vertically stacked: connect right edges outward
            sx = source.x + TABLE_WIDTH;
            tx = target.x + TABLE_WIDTH;
            const curveOffset = Math.max(Math.abs(ty - sy) * 0.35, 70);
            sourceDx = curveOffset;
            targetDx = curveOffset;
          }

          const pathD = `M ${sx} ${sy} C ${sx + sourceDx} ${sy}, ${tx + targetDx} ${ty}, ${tx} ${ty}`;

          d3.select(this).select('.link-hit-area').attr('d', pathD);
          d3.select(this).select('.link-path').attr('d', pathD);

          // Position the midpoint 1:N badge
          const midX = (sx + tx) / 2 + (sourceDx + targetDx) * 0.15;
          const midY = (sy + ty) / 2;

          d3.select(this).select('.link-badge')
            .attr('transform', `translate(${midX - 18}, ${midY - 8})`);
        });
      }

      updateLinks();

      // Fit to view automatically on initial render
      fitToScreen();
    } catch (err) {
      console.error('D3 Schema Rendering Error:', err);
    }
  }, [tables, relationships]);

  // Fit View to all tables
  const fitToScreen = () => {
    if (!svgRef.current || !zoomBehaviorRef.current || nodesRef.current.length === 0) return;

    const svg = d3.select(svgRef.current);
    const nodes = nodesRef.current;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    nodes.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });

    const padding = 70;
    const boundsWidth = maxX - minX + padding * 2;
    const boundsHeight = maxY - minY + padding * 2;

    const svgRect = svgRef.current.getBoundingClientRect();
    const svgWidth = svgRect.width || 1000;
    const svgHeight = svgRect.height || 600;

    const scale = Math.min(
      Math.max(Math.min(svgWidth / boundsWidth, svgHeight / boundsHeight), 0.3),
      1.2
    );

    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const transform = d3.zoomIdentity
      .translate(svgWidth / 2, svgHeight / 2)
      .scale(scale)
      .translate(-midX, -midY);

    svg.transition().duration(500).call(zoomBehaviorRef.current.transform, transform);
  };

  // Zoom controls
  const handleZoomIn = () => {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    d3.select(svgRef.current).transition().duration(250).call(zoomBehaviorRef.current.scaleBy, 1.25);
  };

  const handleZoomOut = () => {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    d3.select(svgRef.current).transition().duration(250).call(zoomBehaviorRef.current.scaleBy, 0.8);
  };

  // Reset to initial clean topological layout
  const handleResetLayout = () => {
    nodesRef.current = JSON.parse(JSON.stringify(initialNodes));
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);

    nodesRef.current.forEach((node) => {
      svg.select(`#table-${node.name}`)
        .transition()
        .duration(400)
        .attr('transform', `translate(${node.x}, ${node.y})`);
    });

    setTimeout(() => {
      fitToScreen();
    }, 450);
  };

  // Focus and pan to searched table
  const handleFocusTable = (tableName: string) => {
    const node = nodesRef.current.find((n) => n.name.toLowerCase() === tableName.toLowerCase());
    if (!node || !svgRef.current || !zoomBehaviorRef.current) return;

    const svg = d3.select(svgRef.current);
    const svgRect = svgRef.current.getBoundingClientRect();
    const svgWidth = svgRect.width || 1000;
    const svgHeight = svgRect.height || 600;

    const transform = d3.zoomIdentity
      .translate(svgWidth / 2, svgHeight / 2)
      .scale(1.0)
      .translate(-(node.x + node.width / 2), -(node.y + node.height / 2));

    svg.transition().duration(500).call(zoomBehaviorRef.current.transform, transform);

    // Flash border highlight
    const tableEl = svg.select(`#table-${node.name} .card-body`);
    tableEl.transition().duration(200).attr('stroke', '#4f46e5').attr('stroke-width', 3)
      .transition().duration(800).attr('stroke', '#e2e8f0').attr('stroke-width', 1.2);
  };

  return (
    <div
      ref={containerRef}
      className="w-full h-[660px] border border-slate-200 rounded-2xl bg-[#fafafa] overflow-hidden relative shadow-inner select-none flex flex-col"
    >
      {/* Top Controls Toolbar */}
      <div className="absolute top-4 left-4 right-4 z-20 flex flex-wrap items-center justify-between gap-3 pointer-events-none">
        {/* Search / Filter Tables */}
        <div className="flex items-center gap-2 pointer-events-auto bg-white/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-200 shadow-sm">
          <Search size={14} className="text-slate-400" />
          <input
            type="text"
            placeholder="Focus table..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchQuery.trim()) {
                handleFocusTable(searchQuery.trim());
              }
            }}
            className="text-xs bg-transparent border-none focus:outline-none w-28 text-slate-700 placeholder:text-slate-400"
          />
          {searchQuery && (
            <button
              onClick={() => {
                handleFocusTable(searchQuery);
              }}
              className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded font-semibold hover:bg-indigo-100"
            >
              Go
            </button>
          )}
        </div>

        {/* View Controls Toolbar */}
        <div className="flex items-center gap-1.5 pointer-events-auto bg-white/90 backdrop-blur-md p-1.5 rounded-xl border border-slate-200 shadow-sm">
          <button
            onClick={handleZoomIn}
            title="Zoom In"
            className="p-1.5 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
          >
            <ZoomIn size={16} />
          </button>
          <button
            onClick={handleZoomOut}
            title="Zoom Out"
            className="p-1.5 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
          >
            <ZoomOut size={16} />
          </button>
          <div className="w-[1px] h-4 bg-slate-200 mx-0.5" />
          <button
            onClick={fitToScreen}
            title="Fit to Screen"
            className="p-1.5 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
          >
            <Maximize2 size={16} />
          </button>
          <button
            onClick={handleResetLayout}
            title="Auto-Align Layout"
            className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
          >
            <RotateCcw size={14} />
            <span className="hidden sm:inline">Auto-Align</span>
          </button>
        </div>
      </div>

      {/* Interactive Canvas */}
      <svg
        ref={svgRef}
        className="w-full h-full cursor-grab active:cursor-grabbing bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] [background-size:20px_20px]"
      />

      {/* Floating Relationship Tooltip */}
      {activeTooltip && (
        <div
          style={{
            left: `${activeTooltip.x + 15}px`,
            top: `${activeTooltip.y - 15}px`,
          }}
          className="absolute pointer-events-none z-30 bg-slate-900/95 text-white p-3 rounded-xl shadow-xl backdrop-blur-md border border-slate-700 text-xs space-y-1.5 max-w-xs animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="font-bold text-indigo-300 flex items-center gap-1.5">
            <span>🔗</span>
            <span>{activeTooltip.title}</span>
          </div>
          <div className="text-slate-300 text-[11px]">{activeTooltip.detail}</div>
          <div className="bg-slate-800/80 px-2 py-1 rounded font-mono text-[10px] text-emerald-300 overflow-x-auto whitespace-nowrap">
            {activeTooltip.joinSql}
          </div>
        </div>
      )}

      {/* Bottom Status & Legend Bar */}
      <div className="absolute bottom-3 left-3 right-3 z-10 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="flex items-center gap-3 bg-white/90 backdrop-blur-md px-3 py-1.5 rounded-full border border-slate-200 text-[11px] text-slate-600 shadow-sm pointer-events-auto">
          <div className="flex items-center gap-1">
            <span>🔑</span>
            <span className="font-semibold text-slate-700">Primary Key</span>
          </div>
          <div className="flex items-center gap-1">
            <span>🔗</span>
            <span className="font-semibold text-slate-700">Foreign Key</span>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 text-slate-400">
            <span>•</span>
            <span>Drag tables to reposition</span>
          </div>
        </div>

        <div className="bg-white/90 backdrop-blur-md px-3 py-1.5 rounded-full border border-slate-200 text-[11px] font-medium text-slate-600 shadow-sm pointer-events-auto flex items-center gap-2">
          <Sparkles size={13} className="text-indigo-600" />
          <span>{tables.length} Tables</span>
          <span className="text-slate-300">•</span>
          <span>{relationships.length} Relational Joins</span>
        </div>
      </div>
    </div>
  );
};

function getTypeColor(typeStr: string): string {
  const t = typeStr.toUpperCase();
  if (t.includes('UUID')) return '#4f46e5'; // indigo
  if (t.includes('INT') || t.includes('SERIAL')) return '#b45309'; // amber
  if (t.includes('CHAR') || t.includes('TEXT')) return '#475569'; // slate
  if (t.includes('TIME') || t.includes('DATE')) return '#0e7490'; // cyan
  if (t.includes('BOOL')) return '#047857'; // emerald
  if (t.includes('DECIMAL') || t.includes('NUMERIC') || t.includes('FLOAT')) return '#be123c'; // rose
  if (t.includes('JSON')) return '#7c3aed'; // violet
  return '#64748b';
}

export default SchemaDiagram;
