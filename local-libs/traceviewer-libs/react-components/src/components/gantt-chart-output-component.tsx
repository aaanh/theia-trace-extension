import * as React from 'react';
import { TimelineChart } from 'timeline-chart/lib/time-graph-model';
import '../../style/react-contextify.css';
import {
    AbstractGanttOutputComponent,
    AbstractGanttOutputProps,
    AbstractGanttOutputState
} from './abstract-gantt-output-component';
import { EntryTree } from './utils/filter-tree/entry-tree';
import { getCollapsedNodesFromAutoExpandLevel, listToTree, validateNumArray } from './utils/filter-tree/utils';
import { QueryHelper, ResponseStatus } from 'tsp-typescript-client';
import ColumnHeader from './utils/filter-tree/column-header';
import { isEqual } from 'lodash';

type GanttChartOutputProps = AbstractGanttOutputProps & {
    initialViewRange?: TimelineChart.TimeGraphRange;
    children?: React.ReactNode;
    onResetZoom?: () => void;
};
type GanttChartOutputState = AbstractGanttOutputState & {
    zoomResetCounter?: number;
    isSyncRange: boolean;
};

export class GanttChartOutputComponent extends AbstractGanttOutputComponent<
    GanttChartOutputProps,
    GanttChartOutputState
> {
    private initialViewRangeSnapshot?: TimelineChart.TimeGraphRange;

    constructor(props: GanttChartOutputProps) {
        super(props);

        this.state = {
            outputStatus: ResponseStatus.RUNNING,
            chartTree: [],
            defaultOrderedIds: [],
            markerCategoryEntries: [],
            markerLayerData: undefined,
            collapsedNodes: validateNumArray(this.props.persistChartState?.collapsedNodes)
                ? (this.props.persistChartState.collapsedNodes as number[])
                : [],
            selectedRow: undefined,
            multiSelectedRows: [],
            selectedMarkerRow: undefined,
            columns: [],
            collapsedMarkerNodes: validateNumArray(this.props.persistChartState?.collapsedMarkerNodes)
                ? (this.props.persistChartState.collapsedMarkerNodes as number[])
                : [],
            showTree: true,
            searchString: '',
            filters: [],
            emptyNodes: [],
            marginTop: 0,
            isSyncRange: false
        };

        // Store a snapshot of the initial view range
        if (props.initialViewRange) {
            this.initialViewRangeSnapshot = { start: props.initialViewRange.start, end: props.initialViewRange.end };
        }
    }

    renderTree(): React.ReactNode {
        this.onOrderChange = this.onOrderChange.bind(this);
        this.onOrderReset = this.onOrderReset.bind(this);
        // TODO Show header, when we can have entries in-line with timeline-chart
        return (
            <>
                <div className="gantt-actions-container">
                    <button
                        className="item gantt-action-button"
                        onClick={() => this.toggleSync()}
                        aria-label="sync analysis mode"
                        style={{
                            background: this.state.isSyncRange ? '#0078d7' : 'var(--theia-button-secondaryBackground)'
                        }}
                    >
                        {this.state.isSyncRange ? (
                            <i className="codicon-sync codicon" />
                        ) : (
                            <i className="codicon-sync-ignored codicon" />
                        )}
                        <span>Range</span>
                    </button>
                </div>
                <div
                    ref={this.chartTreeRef}
                    className="scrollable"
                    onScroll={() => this.synchronizeTreeScroll()}
                    style={{
                        height:
                            parseInt(this.props.style.height.toString()) -
                            this.getMarkersLayerHeight() -
                            (document.getElementById(this.props.traceId + this.props.outputDescriptor.id + 'searchBar')
                                ?.offsetHeight ?? 0)
                    }}
                    tabIndex={0}
                >
                    {this.renderContextMenu()}
                    <EntryTree
                        collapsedNodes={this.state.collapsedNodes}
                        showFilter={false}
                        entries={this.state.chartTree}
                        showCheckboxes={false}
                        onToggleCollapse={this.onToggleCollapse}
                        onRowClick={this.onRowClick}
                        onMultipleRowClick={this.onMultipleRowClick}
                        selectedRow={this.state.selectedRow}
                        multiSelectedRows={this.state.multiSelectedRows}
                        showHeader={true}
                        onContextMenu={this.onCtxMenu}
                        className="table-tree gantt-tree"
                        emptyNodes={this.state.emptyNodes}
                        hideEmptyNodes={this.shouldHideEmptyNodes}
                        onOrderChange={this.onOrderChange}
                        onOrderReset={this.onOrderReset}
                        headers={this.state.columns}
                        hideFillers={true}
                    />
                </div>
                <div ref={this.markerTreeRef} className="scrollable" style={{ height: this.getMarkersLayerHeight() }}>
                    <EntryTree
                        collapsedNodes={this.state.collapsedMarkerNodes}
                        showFilter={false}
                        entries={this.state.markerCategoryEntries}
                        showCheckboxes={false}
                        showCloseIcons={true}
                        onRowClick={this.onMarkerRowClick}
                        selectedRow={this.state.selectedMarkerRow}
                        onToggleCollapse={this.onToggleAnnotationCollapse}
                        onClose={this.onMarkerCategoryRowClose}
                        showHeader={false}
                        className="table-tree ganttchart-tree"
                        hideFillers={true}
                    />
                </div>
            </>
        );
    }

    async fetchTree(): Promise<ResponseStatus> {
        if (this.state.isSyncRange && this.props.selectionRange) {
            const parameters = QueryHelper.timeRangeQuery(
                this.props.selectionRange.getStart(),
                this.props.selectionRange.getEnd()
            );
            const tspClientResponse = await this.props.tspClient.fetchTimeGraphTree(
                this.props.traceId,
                this.props.outputDescriptor.id,
                parameters
            );
            const treeResponse = tspClientResponse.getModel();
            if (tspClientResponse.isOk() && treeResponse) {
                if (treeResponse.model) {
                    const headers = treeResponse.model.headers;
                    const columns: ColumnHeader[] = [];
                    if (headers && headers.length > 0) {
                        headers.forEach(header => {
                            columns.push({
                                title: header.name,
                                sortable: true,
                                resizable: true,
                                tooltip: header.tooltip
                            });
                        });
                    } else {
                        columns.push({ title: '', sortable: true, resizable: true });
                    }

                    const autoCollapsedNodes = getCollapsedNodesFromAutoExpandLevel(
                        listToTree(treeResponse.model.entries, columns),
                        treeResponse.model.autoExpandLevel
                    );

                    this.setState(
                        {
                            outputStatus: treeResponse.status,
                            chartTree: treeResponse.model.entries,
                            defaultOrderedIds: treeResponse.model.entries.map(entry => entry.id),
                            collapsedNodes: autoCollapsedNodes,
                            columns
                        },
                        this.updateTotalHeight
                    );
                } else {
                    this.setState({
                        outputStatus: treeResponse.status
                    });
                }
                return treeResponse.status;
            }
            this.setState({
                outputStatus: ResponseStatus.FAILED
            });
            return ResponseStatus.FAILED;
        } else {
            return super.fetchTree();
        }
    }

    protected async fetchChartData(
        range: TimelineChart.TimeGraphRange,
        resolution: number,
        fetchArrows: boolean,
        rowIds?: number[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        additionalProperties?: { [key: string]: any }
    ): Promise<{ rows: TimelineChart.TimeGraphRowModel[]; range: TimelineChart.TimeGraphRange; resolution: number }> {
        if (this.state.isSyncRange && this.props.selectionRange) {
            const _additionalProperties = {
                ...additionalProperties,
                selection_range: [
                    this.props.selectionRange?.getStart() ??
                        BigInt(0) + (this.props.selectionRange?.getOffset() ?? BigInt(0)),
                    this.props.selectionRange?.getEnd() ??
                        BigInt(0) + (this.props.selectionRange?.getOffset() ?? BigInt(0))
                ]
            };

            return super.fetchChartData(
                { start: this.props.selectionRange?.getStart(), end: this.props.selectionRange?.getEnd() },
                resolution,
                fetchArrows,
                rowIds,
                _additionalProperties
            );
        } else {
            return super.fetchChartData(range, resolution, fetchArrows, rowIds, additionalProperties);
        }
    }

    private toggleSync() {
        this.setState(prev => ({ isSyncRange: !prev.isSyncRange }));
    }

    async componentDidUpdate(prevProps: GanttChartOutputProps, prevState: GanttChartOutputState): Promise<void> {
        super.componentDidUpdate(prevProps, prevState);

        if (
            this.state.isSyncRange &&
            !isEqual(prevProps.selectionRange, this.props.selectionRange && this.props.selectionRange)
        ) {
            this.fetchTree();
            this.chartLayer.update();
            console.log(this.props.selectionRange?.getStart(), this.props.selectionRange?.getEnd());
        }
    }
}
