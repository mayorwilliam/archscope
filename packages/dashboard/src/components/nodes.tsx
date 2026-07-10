import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { FileNodeData, ModuleNodeData, TableNodeData } from "../graph/toFlow";
import { layerColor } from "../graph/toFlow";

/**
 * Node renderers. Data is produced by graph/toFlow.ts — components stay
 * presentation-only. Every interactive element carries a data-testid the
 * Playwright smoke suite keys on.
 */

const HANDLES = (
  <>
    <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
    <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
  </>
);

export interface NodeCallbacks {
  onToggleExpand?: ((moduleId: string) => void) | undefined;
}

/** React Flow gives no way to pass callbacks but node data; a context would
 * re-render every node — module-level registry keeps it simple and static. */
export const nodeCallbacks: NodeCallbacks = {};

function statusClass(status: string | undefined): string {
  return status ? ` status-${status}` : "";
}

export function ModuleNode({ data, selected }: NodeProps) {
  const d = data as unknown as ModuleNodeData;
  return (
    <div
      className={`arch-node${statusClass(d.status)}${selected ? " selected" : ""}`}
      data-testid="module-node"
      data-module-id={d.moduleId}
      data-status={d.status ?? "unchanged"}
    >
      {HANDLES}
      <div className="title">
        {d.layer !== undefined && (
          <span className="layer-chip" style={{ background: layerColor(d.layer) }}>
            {d.layer}
          </span>
        )}
        <span className="name">{d.name}</span>
        {d.expandable && (
          <button
            type="button"
            className="expand-btn"
            data-testid="expand-btn"
            title="Expand files"
            onClick={(event) => {
              event.stopPropagation();
              nodeCallbacks.onToggleExpand?.(d.moduleId);
            }}
          >
            +
          </button>
        )}
      </div>
      <div className="subtitle">
        {d.status === "removed"
          ? (d.statusDetail ?? "removed in head")
          : (d.statusDetail ?? `${d.files} files · ${d.loc.toLocaleString()} loc`)}
      </div>
    </div>
  );
}

export function ModuleGroupNode({ data }: NodeProps) {
  const d = data as unknown as ModuleNodeData;
  return (
    <div className="module-group" data-testid="module-group" data-module-id={d.moduleId}>
      {HANDLES}
      <div className="group-header">
        {d.layer !== undefined && (
          <span className="layer-chip" style={{ background: layerColor(d.layer) }}>
            {d.layer}
          </span>
        )}
        <span className="name">{d.name}</span>
        {d.expandable && (
          <button
            type="button"
            className="expand-btn"
            data-testid="collapse-btn"
            title="Collapse"
            onClick={(event) => {
              event.stopPropagation();
              nodeCallbacks.onToggleExpand?.(d.moduleId);
            }}
          >
            −
          </button>
        )}
      </div>
    </div>
  );
}

export function FileNode({ data, selected }: NodeProps) {
  const d = data as unknown as FileNodeData;
  return (
    <div
      className={`file-node${selected ? " selected" : ""}`}
      data-testid="file-node"
      data-file-id={d.fileId}
      title={d.path}
    >
      {HANDLES}
      <div className="path">{d.fileName}</div>
      <div className="loc">{d.loc} loc</div>
    </div>
  );
}

export function ExtModuleNode({ data }: NodeProps) {
  const d = data as unknown as { moduleId: string; name: string };
  return (
    <div className="arch-node ext-module" data-testid="ext-module-node" data-module-id={d.moduleId}>
      {HANDLES}
      <div className="title">
        <span className="name">{d.name}</span>
      </div>
      <div className="subtitle">module</div>
    </div>
  );
}

export function TableNode({ data, selected }: NodeProps) {
  const d = data as unknown as TableNodeData;
  return (
    <div
      className={`table-node${selected ? " selected" : ""}`}
      data-testid="table-node"
      data-table-id={d.tableId}
    >
      {HANDLES}
      <div className="table-header">
        <span className="schema">{d.schema}.</span>
        <span>{d.name}</span>
        {d.driftCount > 0 && (
          <span className="drift-badge" data-testid="drift-badge" title="Schema drift entries">
            ⚠ {d.driftCount}
          </span>
        )}
      </div>
      {d.entities.length > 0 && (
        <div className="entity-chips">
          {d.entities.map((entity) => (
            <span
              key={entity.id}
              className={`entity-chip${entity.confidence === "inferred" ? " inferred" : ""}`}
              title={`${entity.orm} entity (${entity.confidence})`}
            >
              {entity.name}
            </span>
          ))}
        </div>
      )}
      {d.columns.map((column) => (
        <div className="column-row" key={column.name}>
          {column.isPk && <span className="key pk">PK</span>}
          {column.fkTo && (
            <span className="key fk" title={`→ ${column.fkTo.table}.${column.fkTo.column}`}>
              FK
            </span>
          )}
          <span className="col-name">{column.name}</span>
          <span className="col-type">
            {column.sqlType}
            {column.nullable ? "?" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export const nodeTypes = {
  module: ModuleNode,
  moduleGroup: ModuleGroupNode,
  file: FileNode,
  extModule: ExtModuleNode,
  table: TableNode,
};
