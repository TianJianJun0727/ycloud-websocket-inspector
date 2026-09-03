import type { WebSocketTargetType } from '../types/capture';

/** Worker 运行时返回的最小环境特征。 */
export interface WorkerScope {
    scopeName?: string;
    scopeType?: WebSocketTargetType | '';
    href?: string;
}

/** 将 Chrome 通用 worker target 与运行时作用域共同归一化为准确类型。 */
export const resolveWebSocketTargetType = (
    debuggerTargetType: string,
    scope: WorkerScope | undefined,
): WebSocketTargetType | null => {
    const scopeName = scope?.scopeName || '';
    if (
        debuggerTargetType === 'shared_worker' ||
        scope?.scopeType === 'shared_worker' ||
        scopeName.includes('SharedWorkerGlobalScope')
    ) {
        return 'shared_worker';
    }
    if (debuggerTargetType === 'page') return 'page';
    if (
        debuggerTargetType === 'worker' ||
        scope?.scopeType === 'worker' ||
        scopeName.includes('DedicatedWorkerGlobalScope')
    ) {
        return 'worker';
    }
    return null;
};
