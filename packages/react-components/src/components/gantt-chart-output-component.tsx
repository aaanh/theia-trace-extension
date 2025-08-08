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
import { TimeRange } from 'traceviewer-base/src/utils/time-range';
import { BIMath } from 'timeline-chart/lib/bigint-utils';
import ColumnHeader from './utils/filter-tree/column-header';
import { isEqual } from 'lodash';

type GanttChartOutputProps = AbstractGanttOutputProps & {
    initialViewRange?: TimelineChart.TimeGraphRange;
    children?: React.ReactNode;
    onResetZoom?: () => void;
    syncedRange: { start?: bigint; end?: bigint; offset: bigint } | undefined;
};
type GanttChartOutputState = AbstractGanttOutputState & {
    zoomResetCounter?: number;
    isSyncRange: boolean;
};

export class GanttChartOutputComponent extends AbstractGanttOutputComponent<
    GanttChartOutputProps,
    GanttChartOutputState
> {
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
    }

    private updateSyncModeUnitController(range: TimelineChart.TimeGraphRange): void {
        const selectionDuration = range.end - range.start;
        this.props.unitController.absoluteRange = selectionDuration;
        // Keep the view range spanning the full width but with normalized coordinates
        this.props.unitController.viewRange = { start: BigInt(0), end: selectionDuration };

        // Force complete chart refresh with new range
        this.chartLayer.updateChart();
        // Also update the chart layer to ensure proper rendering
        setTimeout(() => {
            this.chartLayer.update();
            // Force a resize event to ensure proper width calculation
            window.dispatchEvent(new Event('resize'));
            // Force chart to rebuild with new data
            this.chartLayer.updateChart();
        }, 0);
    }

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        // Listen for selection range changes to update sync mode
        this.props.unitController.onSelectionRangeChange(range => {
            if (this.state.isSyncRange && range) {
                this.updateSyncModeUnitController(range);
            }
        });

        // Override view range changes to prevent resetting in sync mode
        this.props.unitController.onViewRangeChanged((oldRange, newRange) => {
            if (this.state.isSyncRange) {
                // In sync mode, prevent view range changes that would reset the x-axis
                const selectionDuration = this.props.syncedRange!.end! - this.props.syncedRange!.start!;
                this.props.unitController.viewRange = { start: BigInt(0), end: selectionDuration };
            }
        });
    }

    async fetchTree(): Promise<ResponseStatus> {
        const parameters = this.state.isSyncRange
            ? QueryHelper.timeRangeQuery(BigInt(0), BigInt('99999999999999999999999999999999999'), {
                  selection_range: [this.props.syncedRange!.start!, this.props.syncedRange!.end!]
              })
            : QueryHelper.timeRangeQuery(this.props.range.getStart(), this.props.range.getEnd());
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
                        columns.push({ title: header.name, sortable: true, resizable: true, tooltip: header.tooltip });
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
                        onClick={this.handleSyncXRange}
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

    protected async fetchChartData(
        range: TimelineChart.TimeGraphRange,
        resolution: number,
        fetchArrows: boolean,
        rowIds?: number[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        additionalProperties?: { [key: string]: any }
    ) {
        if (document.getElementById(this.props.traceId + this.props.outputDescriptor.id + 'handleSpinner')) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            document.getElementById(
                this.props.traceId + this.props.outputDescriptor.id + 'handleSpinner'
            )!.style.visibility = 'visible';
        }

        const strategy = additionalProperties?.filter_query_parameters?.strategy;
        const ids = rowIds ? rowIds : this.getTimegraphRowIds().rowIds;
        const { start, end } = range;

        let newRange: TimelineChart.TimeGraphRange = { start: BigInt(0), end: BigInt(0) };
        let syncAnalysisMode = false;
        let selectionRange: TimelineChart.TimeGraphRange | undefined;

        if (this.state.isSyncRange) {
            console.log('Using synced range analysis mode');
            const normStart = this.props.syncedRange!.start!;
            const normEnd = this.props.syncedRange!.end!;

            selectionRange = {
                start: BIMath.min(normStart, normEnd),
                end: BIMath.max(normStart, normEnd)
            };

            // For sync analysis mode, fetch the full range but we'll normalize the time coordinates
            newRange = {
                start: BigInt(0),
                end: this.props.range.getEnd() - this.props.range.getStart()
            };
            syncAnalysisMode = true;
        } else {
            console.log('Using base range');
            newRange = range;
        }
        const nbTimes = Math.ceil(Number(newRange.end - newRange.start) / resolution) + 1;

        let timeGraphData: TimelineChart.TimeGraphModel;
        if (syncAnalysisMode && selectionRange) {
            // Use sync analysis mode to get full range with normalized time coordinates
            timeGraphData = await this.tspDataProvider.getDataForSyncAnalysis(
                ids,
                this.state.chartTree,
                fetchArrows,
                this.props.range,
                selectionRange,
                nbTimes,
                this.props.markerCategories,
                this.props.markerSetId,
                additionalProperties
            );
        } else {
            // Use normal mode
            timeGraphData = await this.tspDataProvider.getData(
                ids,
                this.state.chartTree,
                fetchArrows,
                this.props.range,
                newRange,
                nbTimes,
                this.props.markerCategories,
                this.props.markerSetId,
                additionalProperties
            );
        }
        this.updateMarkersData(timeGraphData.rangeEvents, newRange, nbTimes);
        this.rangeEventsLayer.addRangeEvents(timeGraphData.rangeEvents);

        if (document.getElementById(this.props.traceId + this.props.outputDescriptor.id + 'handleSpinner')) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            document.getElementById(
                this.props.traceId + this.props.outputDescriptor.id + 'handleSpinner'
            )!.style.visibility = 'hidden';
        }

        let rows = timeGraphData ? timeGraphData.rows : [];
        let emptyNodes: number[] = [...this.state.emptyNodes];
        if (this.shouldHideEmptyNodes) {
            rows = rows.filter(row => {
                if (this.isFilteredIn(row, strategy)) {
                    emptyNodes = emptyNodes.filter(id => id !== row.id);
                    return true;
                }
                if (!emptyNodes.includes(row.id)) {
                    emptyNodes.push(row.id);
                }
                return false;
            });
        } else {
            emptyNodes = [];
        }

        if (fetchArrows) {
            this.arrowLayer.addArrows(
                timeGraphData.arrows,
                this.getTimegraphRowIds().rowIds.filter(rowId => !emptyNodes.includes(rowId))
            );
        }
        this.setState({ emptyNodes });

        // Apply the pending selection here since the row provider had been called before this method.
        if (this.pendingSelection) {
            const foundElement = this.pendingSelection;
            this.pendingSelection = undefined;
            this.selectAndReveal(foundElement);
        }
        // Update unit controller for sync analysis mode
        if (syncAnalysisMode && selectionRange) {
            // In sync analysis mode, update the unit controller to use normalized time range
            const selectionDuration = selectionRange.end - selectionRange.start;
            this.props.unitController.absoluteRange = selectionDuration;
            this.props.unitController.viewRange = { start: BigInt(0), end: selectionDuration };
        }

        return {
            rows: rows,
            range: newRange,
            resolution: resolution
        };
    }

    private handleSyncXRange = () => {
        console.log('Synced range: ', this.props.syncedRange?.start, this.props.syncedRange?.end);
        this.setState(
            prev => ({ isSyncRange: !prev.isSyncRange }),
            () => {
                // Update unit controller after state change
                if (this.state.isSyncRange && this.props.syncedRange) {
                    const selectionDuration = this.props.syncedRange.end! - this.props.syncedRange.start!;
                    this.props.unitController.absoluteRange = selectionDuration;
                    this.props.unitController.viewRange = { start: BigInt(0), end: selectionDuration };
                } else if (!this.state.isSyncRange) {
                    // Reset to original range when sync is disabled
                    const originalRange = this.props.range.getEnd() - this.props.range.getStart();
                    this.props.unitController.absoluteRange = originalRange;
                    this.props.unitController.viewRange = { start: BigInt(0), end: originalRange };
                }
                this.chartLayer.updateChart();
            }
        );
    };

    async componentDidUpdate(prevProps: GanttChartOutputProps, prevState: GanttChartOutputState): Promise<void> {
        super.componentDidUpdate(prevProps, prevState);

        const syncModeChanged = !isEqual(prevState.isSyncRange, this.state.isSyncRange);
        const syncedRangeChanged = !isEqual(prevProps.syncedRange, this.props.syncedRange);

        if (syncModeChanged || syncedRangeChanged) {
            this.fetchTree();
            this.chartLayer.updateChart();

            // Update unit controller when sync mode changes
            if (this.state.isSyncRange && this.props.syncedRange) {
                const selectionDuration = this.props.syncedRange.end! - this.props.syncedRange.start!;
                this.props.unitController.absoluteRange = selectionDuration;
                this.props.unitController.viewRange = { start: BigInt(0), end: selectionDuration };
            } else if (!this.state.isSyncRange) {
                // Reset to original range when sync is disabled
                const originalRange = this.props.range.getEnd() - this.props.range.getStart();
                this.props.unitController.absoluteRange = originalRange;
                this.props.unitController.viewRange = { start: BigInt(0), end: originalRange };
            }
        }

        // Also check if we're in sync mode and the selection range has changed
        if (this.state.isSyncRange && this.props.unitController.selectionRange && syncedRangeChanged) {
            const selectionRange = this.props.unitController.selectionRange;
            this.updateSyncModeUnitController(selectionRange);
        }
    }
}
