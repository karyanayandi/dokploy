import copy from "copy-to-clipboard";
import {
	Check,
	Copy,
	Download as DownloadIcon,
	Loader2,
	Pause,
	Play,
} from "lucide-react";
import type React from "react";
import { useEffect, useReducer, useRef } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";
import { LineCountFilter } from "./line-count-filter";
import { SinceLogsFilter, type TimeFilter } from "./since-logs-filter";
import { StatusLogsFilter } from "./status-logs-filter";
import { TerminalLine } from "./terminal-line";
import { getLogType, type LogLine, parseLogs } from "./utils";

interface Props {
	containerId: string;
	serverId?: string | null;
	runType: "swarm" | "native";
}

export const priorities = [
	{
		label: "Info",
		value: "info",
	},
	{
		label: "Success",
		value: "success",
	},
	{
		label: "Warning",
		value: "warning",
	},
	{
		label: "Debug",
		value: "debug",
	},
	{
		label: "Error",
		value: "error",
	},
];

// --- Reducer ---

type DockerLogsState = {
	rawLogs: string;
	filteredLogs: LogLine[];
	autoScroll: boolean;
	lines: number;
	search: string;
	showTimestamp: boolean;
	since: TimeFilter;
	typeFilter: string[];
	isPaused: boolean;
	messageBuffer: string[];
	isLoading: boolean;
	copied: boolean;
};

const dockerLogsInitialState: DockerLogsState = {
	rawLogs: "",
	filteredLogs: [],
	autoScroll: true,
	lines: 100,
	search: "",
	showTimestamp: true,
	since: "all",
	typeFilter: [],
	isPaused: false,
	messageBuffer: [],
	isLoading: false,
	copied: false,
};

type DockerLogsAction =
	| { type: "SET_RAW_LOGS"; payload: string }
	| { type: "APPEND_RAW_LOGS"; payload: { data: string; maxLines: number } }
	| { type: "SET_FILTERED_LOGS"; payload: LogLine[] }
	| { type: "SET_AUTO_SCROLL"; payload: boolean }
	| { type: "SET_LINES"; payload: number }
	| { type: "SET_SEARCH"; payload: string }
	| { type: "SET_SHOW_TIMESTAMP"; payload: boolean }
	| { type: "SET_SINCE"; payload: TimeFilter }
	| { type: "SET_TYPE_FILTER"; payload: string[] }
	| { type: "SET_IS_PAUSED"; payload: boolean }
	| { type: "APPEND_BUFFER"; payload: string }
	| { type: "FLUSH_BUFFER"; payload: { maxLines: number } }
	| { type: "SET_IS_LOADING"; payload: boolean }
	| { type: "SET_COPIED"; payload: boolean }
	| { type: "RESET_LOGS" };

function dockerLogsReducer(
	state: DockerLogsState,
	action: DockerLogsAction,
): DockerLogsState {
	switch (action.type) {
		case "SET_RAW_LOGS":
			return { ...state, rawLogs: action.payload };
		case "APPEND_RAW_LOGS": {
			const updated = state.rawLogs + action.payload.data;
			const splitLines = updated.split("\n");
			return {
				...state,
				rawLogs:
					splitLines.length > action.payload.maxLines
						? splitLines.slice(-action.payload.maxLines).join("\n")
						: updated,
			};
		}
		case "SET_FILTERED_LOGS":
			return { ...state, filteredLogs: action.payload };
		case "SET_AUTO_SCROLL":
			return { ...state, autoScroll: action.payload };
		case "SET_LINES":
			return { ...state, lines: action.payload };
		case "SET_SEARCH":
			return { ...state, search: action.payload };
		case "SET_SHOW_TIMESTAMP":
			return { ...state, showTimestamp: action.payload };
		case "SET_SINCE":
			return { ...state, since: action.payload };
		case "SET_TYPE_FILTER":
			return { ...state, typeFilter: action.payload };
		case "SET_IS_PAUSED":
			return { ...state, isPaused: action.payload };
		case "APPEND_BUFFER":
			return {
				...state,
				messageBuffer: [...state.messageBuffer, action.payload],
			};
		case "FLUSH_BUFFER": {
			if (state.messageBuffer.length === 0) {
				return { ...state, isPaused: false };
			}
			const bufferedContent = state.messageBuffer.join("");
			const updated = state.rawLogs + bufferedContent;
			const splitLines = updated.split("\n");
			const newRaw =
				splitLines.length > action.payload.maxLines
					? splitLines.slice(-action.payload.maxLines).join("\n")
					: updated;
			return { ...state, rawLogs: newRaw, messageBuffer: [], isPaused: false };
		}
		case "SET_IS_LOADING":
			return { ...state, isLoading: action.payload };
		case "SET_COPIED":
			return { ...state, copied: action.payload };
		case "RESET_LOGS":
			return {
				...state,
				rawLogs: "",
				filteredLogs: [],
				messageBuffer: [],
				isPaused: false,
				isLoading: true,
			};
		default:
			return state;
	}
}

export const DockerLogsId: React.FC<Props> = ({
	containerId,
	serverId,
	runType,
}) => {
	const { data } = api.docker.getConfig.useQuery(
		{
			containerId,
			serverId: serverId ?? undefined,
		},
		{
			enabled: !!containerId,
		},
	);

	const [state, dispatch] = useReducer(
		dockerLogsReducer,
		dockerLogsInitialState,
	);
	const {
		rawLogs,
		filteredLogs,
		autoScroll,
		lines,
		search,
		showTimestamp,
		since,
		typeFilter,
		isPaused,
		messageBuffer,
		isLoading,
		copied,
	} = state;

	// Keep a ref in sync with isPaused so WebSocket callbacks don't capture stale state
	const isPausedRef = useRef(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		isPausedRef.current = isPaused;
	}, [isPaused]);

	const scrollToBottom = () => {
		if (autoScroll && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	};

	const handleScroll = () => {
		if (!scrollRef.current) return;

		const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
		const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 10;
		dispatch({ type: "SET_AUTO_SCROLL", payload: isAtBottom });
	};

	const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
		dispatch({ type: "SET_SEARCH", payload: e.target.value || "" });
	};

	const handleLines = (newLines: number) => {
		dispatch({ type: "SET_LINES", payload: newLines });
		// Reset logs; the WebSocket effect will re-connect due to lines dependency
		dispatch({ type: "RESET_LOGS" });
	};

	const handleSince = (value: TimeFilter) => {
		dispatch({ type: "SET_SINCE", payload: value });
		// Reset logs; the WebSocket effect will re-connect due to since dependency
		dispatch({ type: "RESET_LOGS" });
	};

	const handlePauseResume = () => {
		if (isPaused) {
			// Resume: flush buffered messages into rawLogs
			dispatch({ type: "FLUSH_BUFFER", payload: { maxLines: lines } });
		} else {
			dispatch({ type: "SET_IS_PAUSED", payload: true });
		}
		isPausedRef.current = !isPaused;
	};

	useEffect(() => {
		if (!containerId) return;

		let isCurrentConnection = true;
		let noDataTimeout: NodeJS.Timeout;
		dispatch({ type: "RESET_LOGS" });
		isPausedRef.current = false;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const params = new globalThis.URLSearchParams({
			containerId,
			tail: lines.toString(),
			since,
			search,
			runType,
		});

		if (serverId) {
			params.append("serverId", serverId);
		}

		const wsUrl = `${protocol}//${
			window.location.host
		}/docker-container-logs?${params.toString()}`;
		const ws = new WebSocket(wsUrl);

		const resetNoDataTimeout = () => {
			if (noDataTimeout) clearTimeout(noDataTimeout);
			noDataTimeout = setTimeout(() => {
				if (isCurrentConnection) {
					dispatch({ type: "SET_IS_LOADING", payload: false });
				}
			}, 2000); // Wait 2 seconds for data before showing "No logs found"
		};

		ws.onopen = () => {
			if (!isCurrentConnection) {
				ws.close();
				return;
			}
			resetNoDataTimeout();
		};

		ws.onmessage = (e) => {
			if (!isCurrentConnection) return;

			if (isPausedRef.current) {
				// When paused, buffer the messages instead of displaying them
				dispatch({ type: "APPEND_BUFFER", payload: e.data });
			} else {
				// When not paused, append to rawLogs (truncated to maxLines)
				dispatch({
					type: "APPEND_RAW_LOGS",
					payload: { data: e.data, maxLines: lines },
				});
			}

			dispatch({ type: "SET_IS_LOADING", payload: false });
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};

		ws.onerror = (error) => {
			if (!isCurrentConnection) return;
			console.error("WebSocket error:", error);
			dispatch({ type: "SET_IS_LOADING", payload: false });
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};

		ws.onclose = (e) => {
			if (!isCurrentConnection) return;
			console.log("WebSocket closed:", e.reason);
			dispatch({ type: "SET_IS_LOADING", payload: false });
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};

		return () => {
			isCurrentConnection = false;
			if (noDataTimeout) clearTimeout(noDataTimeout);
			if (ws.readyState === WebSocket.OPEN) {
				ws.close();
			}
		};
	}, [containerId, serverId, lines, search, since]);

	const handleDownload = () => {
		const logContent = filteredLogs
			.map(
				({ timestamp, message }: { timestamp: Date | null; message: string }) =>
					`${timestamp?.toISOString() || "No timestamp"} ${message}`,
			)
			.join("\n");

		const blob = new Blob([logContent], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		const appName = data.Name.replace("/", "") || "app";
		const isoDate = new Date().toISOString();
		a.href = url;
		a.download = `${appName}-${isoDate.slice(0, 10).replace(/-/g, "")}_${isoDate
			.slice(11, 19)
			.replace(/:/g, "")}.log.txt`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const handleCopy = async () => {
		const logContent = filteredLogs
			.map(
				({
					timestamp,
					message,
				}: {
					timestamp: Date | null;
					message: string;
				}) =>
					showTimestamp
						? `${timestamp?.toISOString() || "No timestamp"} ${message}`
						: message,
			)
			.join("\n");

		const success = copy(logContent);
		if (success) {
			dispatch({ type: "SET_COPIED", payload: true });
			setTimeout(() => dispatch({ type: "SET_COPIED", payload: false }), 2000);
		}
	};

	const handleFilter = (logs: LogLine[]) => {
		return logs.filter((log) => {
			const logType = getLogType(log.message).type;

			if (typeFilter.length === 0) {
				return true;
			}

			return typeFilter.includes(logType);
		});
	};

	useEffect(() => {
		dispatch({ type: "RESET_LOGS" });
	}, [containerId]);

	useEffect(() => {
		const logs = parseLogs(rawLogs);
		const filtered = handleFilter(logs);
		dispatch({ type: "SET_FILTERED_LOGS", payload: filtered });
	}, [rawLogs, search, lines, since, typeFilter]);

	useEffect(() => {
		scrollToBottom();

		if (autoScroll && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [filteredLogs, autoScroll]);

	return (
		<div className="flex flex-col gap-4">
			<div className="rounded-lg">
				<div className="space-y-4">
					<div className="flex flex-wrap justify-between items-start sm:items-center gap-4">
						<div className="flex flex-wrap gap-4">
							<LineCountFilter value={lines} onValueChange={handleLines} />

							<SinceLogsFilter
								value={since}
								onValueChange={handleSince}
								showTimestamp={showTimestamp}
								onTimestampChange={(val) =>
									dispatch({ type: "SET_SHOW_TIMESTAMP", payload: val })
								}
							/>

							<StatusLogsFilter
								value={typeFilter}
								setValue={(val) =>
									dispatch({ type: "SET_TYPE_FILTER", payload: val })
								}
								title="Log type"
								options={priorities}
							/>

							<Input
								type="search"
								placeholder="Search logs..."
								value={search}
								onChange={handleSearch}
								className="inline-flex h-9 text-sm placeholder-gray-400 w-full sm:w-auto"
							/>
						</div>

						<div className="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								className="h-9"
								onClick={handlePauseResume}
								title={isPaused ? "Resume logs" : "Pause logs"}
							>
								{isPaused ? (
									<Play className="mr-2 h-4 w-4" />
								) : (
									<Pause className="mr-2 h-4 w-4" />
								)}
								{isPaused ? "Resume" : "Pause"}
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="h-9"
								onClick={handleCopy}
								disabled={filteredLogs.length === 0}
								title="Copy logs to clipboard"
							>
								{copied ? (
									<Check className="mr-2 h-4 w-4" />
								) : (
									<Copy className="mr-2 h-4 w-4" />
								)}
								Copy
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="h-9 sm:w-auto w-full"
								onClick={handleDownload}
								disabled={filteredLogs.length === 0 || !data?.Name}
							>
								<DownloadIcon className="mr-2 h-4 w-4" />
								Download logs
							</Button>
						</div>
					</div>
					{isPaused && (
						<AlertBlock type="warning">
							<div className="flex items-center gap-2">
								<Pause className="h-4 w-4" />
								<span>
									Logs paused
									{messageBuffer.length > 0 && (
										<span className="ml-1 font-medium">
											({messageBuffer.length} messages buffered)
										</span>
									)}
								</span>
							</div>
						</AlertBlock>
					)}
					<div
						ref={scrollRef}
						onScroll={handleScroll}
						className="h-[720px] overflow-y-auto space-y-0 border p-4 bg-[#fafafa] dark:bg-[#050506] rounded custom-logs-scrollbar"
					>
						{filteredLogs.length > 0 ? (
							filteredLogs.map((filteredLog: LogLine, index: number) => (
								<TerminalLine
									key={index}
									log={filteredLog}
									searchTerm={search}
									noTimestamp={!showTimestamp}
								/>
							))
						) : isLoading ? (
							<div className="flex justify-center items-center h-full text-muted-foreground">
								<Loader2 className="h-6 w-6 animate-spin" />
							</div>
						) : (
							<div className="flex justify-center items-center h-full text-muted-foreground">
								No logs found
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};
