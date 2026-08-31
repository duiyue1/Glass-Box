import { extractLinks, parseSourceRef, type WikiPage } from './wiki.ts';

export type WikiGraphNodeKind = 'page' | 'source_chunk';
export type WikiRelationType = 'wiki_link' | 'supports' | 'same_source' | 'dangling';
export type WikiRelationStatus = 'active' | 'dangling' | 'stale';

export interface WikiGraphNode {
  id: string;
  kind: WikiGraphNodeKind;
  ref?: string;
  title: string;
  type?: WikiPage['type'];
  summary?: string;
  verified?: boolean;
  stale?: boolean;
  isolated?: boolean;
  sources?: string[];
  related?: string[];
  backlinks?: string[];
}

export interface WikiGraphEdge {
  source: string;
  target: string;
  type: WikiRelationType;
  status: WikiRelationStatus;
  confidence: 'explicit' | 'derived';
  sourceRef?: string;
}

export interface WikiGraphIssue {
  severity: 'warning' | 'error';
  code: 'isolated_page' | 'dangling_link' | 'missing_source';
  ref: string;
  target?: string;
  message: string;
}

export interface WikiImpactItem {
  id: string;
  kind: WikiGraphNodeKind;
  distance: number;
  direction: 'incoming' | 'outgoing';
  via: WikiRelationType;
  status: WikiRelationStatus;
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  issues: WikiGraphIssue[];
  metadata: {
    pageCount: number;
    pageEdgeCount: number;
    sourceChunkCount: number;
    danglingCount: number;
    isolatedCount: number;
  };
}

function sourceChunkId(sourceRef: string): string {
  return `source_chunk:${sourceRef}`;
}

function addEdge(edges: WikiGraphEdge[], seen: Set<string>, edge: WikiGraphEdge): void {
  const key = `${edge.source}\u0000${edge.target}\u0000${edge.type}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(edge);
}

/**
 * Build all wiki relations from Markdown-backed pages.
 * The returned graph is derived data: callers can rebuild it after every import/edit.
 */
export function wikiImpact(graph: WikiGraph, start: string, maxDepth = 2): WikiImpactItem[] {
  const edges = graph.edges.filter((edge) => edge.type !== 'dangling');
  const found = new Map<string, WikiImpactItem>();
  const queue: { id: string; distance: number }[] = [{ id: start, distance: 0 }];
  const seen = new Set([start]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.distance >= maxDepth) continue;
    for (const edge of edges) {
      const next: { id: string; direction: 'incoming' | 'outgoing' }[] = [];
      if (edge.source === current.id) next.push({ id: edge.target, direction: 'outgoing' });
      if (edge.target === current.id) next.push({ id: edge.source, direction: 'incoming' });
      for (const item of next) {
        const distance = current.distance + 1;
        const node = graph.nodes.find((candidate) => candidate.id === item.id);
        if (!node) continue;
        if (!found.has(item.id)) found.set(item.id, { id: item.id, kind: node.kind, distance, direction: item.direction, via: edge.type, status: edge.status });
        if (!seen.has(item.id)) {
          seen.add(item.id);
          queue.push({ id: item.id, distance });
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
}

export function buildWikiGraph(
  pages: readonly WikiPage[],
  isStale: (page: WikiPage) => boolean = () => false,
): WikiGraph {
  const known = new Map(pages.map((page) => [page.ref, page]));
  const backlinks = new Map<string, string[]>();
  const nodes: WikiGraphNode[] = [];
  const edges: WikiGraphEdge[] = [];
  const seenEdges = new Set<string>();
  const pageDegree = new Map<string, number>();

  for (const page of pages) {
    const stale = isStale(page);
    const links = [...new Set([...page.related, ...extractLinks(page.body)])].filter((ref) => ref !== page.ref);
    nodes.push({
      id: page.ref,
      kind: 'page',
      ref: page.ref,
      title: page.title,
      type: page.type,
      summary: page.summary,
      verified: page.verified,
      stale,
      sources: [...page.sources],
      related: links,
      backlinks: [],
    });
    pageDegree.set(page.ref, 0);

    for (const ref of links) {
      const target = known.get(ref);
      if (!target) {
        addEdge(edges, seenEdges, {
          source: page.ref,
          target: ref,
          type: 'dangling',
          status: 'dangling',
          confidence: 'explicit',
        });
        continue;
      }
      addEdge(edges, seenEdges, {
        source: page.ref,
        target: target.ref,
        type: 'wiki_link',
        status: stale || isStale(target) ? 'stale' : 'active',
        confidence: 'explicit',
      });
      pageDegree.set(page.ref, (pageDegree.get(page.ref) ?? 0) + 1);
      pageDegree.set(target.ref, (pageDegree.get(target.ref) ?? 0) + 1);
      const refs = backlinks.get(target.ref) ?? [];
      if (!refs.includes(page.ref)) refs.push(page.ref);
      backlinks.set(target.ref, refs);
    }

  }

  const pagesBySource = new Map<string, string[]>();
  for (const page of pages) {
    for (const sourceRef of page.sources) {
      const parsed = parseSourceRef(sourceRef);
      if (!parsed) continue;
      const chunkId = sourceChunkId(sourceRef);
      if (!nodes.some((node) => node.id === chunkId)) {
        nodes.push({
          id: chunkId,
          kind: 'source_chunk',
          title: `${parsed.docId} #${parsed.index}`,
        });
      }
      addEdge(edges, seenEdges, {
        source: page.ref,
        target: chunkId,
        type: 'supports',
        status: isStale(page) ? 'stale' : 'active',
        confidence: 'derived',
        sourceRef,
      });
      pageDegree.set(page.ref, (pageDegree.get(page.ref) ?? 0) + 1);
      const refs = pagesBySource.get(sourceRef) ?? [];
      if (!refs.includes(page.ref)) refs.push(page.ref);
      pagesBySource.set(sourceRef, refs);
    }
  }

  for (const [sourceRef, refs] of pagesBySource) {
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        addEdge(edges, seenEdges, {
          source: refs[i],
          target: refs[j],
          type: 'same_source',
          status: refs.some((ref) => isStale(known.get(ref)!)) ? 'stale' : 'active',
          confidence: 'derived',
          sourceRef,
        });
        pageDegree.set(refs[i], (pageDegree.get(refs[i]) ?? 0) + 1);
        pageDegree.set(refs[j], (pageDegree.get(refs[j]) ?? 0) + 1);
      }
    }
  }

  for (const node of nodes) {
    if (node.kind !== 'page') continue;
    node.backlinks = backlinks.get(node.ref!) ?? [];
    node.isolated = (pageDegree.get(node.ref!) ?? 0) === 0;
  }

  const issues: WikiGraphIssue[] = [];
  for (const page of pages) {
    const links = [...new Set([...page.related, ...extractLinks(page.body)])].filter((ref) => ref !== page.ref);
    for (const target of links) {
      if (!known.has(target)) {
        issues.push({
          severity: 'error',
          code: 'dangling_link',
          ref: page.ref,
          target,
          message: `${page.ref} 指向不存在的条目 ${target}`,
        });
      }
    }
    const invalidSources = page.sources.filter((sourceRef) => !parseSourceRef(sourceRef));
    for (const sourceRef of invalidSources) {
      issues.push({
        severity: 'error',
        code: 'missing_source',
        ref: page.ref,
        target: sourceRef,
        message: `${page.ref} 的来源引用格式无效：${sourceRef}`,
      });
    }
    if (page.type !== 'source' && pages.length > 1 && (pageDegree.get(page.ref) ?? 0) === 0) {
      issues.push({
        severity: 'warning',
        code: 'isolated_page',
        ref: page.ref,
        message: `${page.ref} 没有显式链接或来源关系`,
      });
    }
  }

  return {
    nodes,
    edges,
    issues,
    metadata: {
      pageCount: pages.length,
      pageEdgeCount: edges.filter((edge) => edge.type === 'wiki_link' || edge.type === 'dangling').length,
      sourceChunkCount: nodes.filter((node) => node.kind === 'source_chunk').length,
      danglingCount: issues.filter((issue) => issue.code === 'dangling_link').length,
      isolatedCount: issues.filter((issue) => issue.code === 'isolated_page').length,
    },
  };
}
