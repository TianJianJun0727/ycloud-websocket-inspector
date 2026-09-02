import Dexie, { type EntityTable } from 'dexie';

import type { ConnectionRecord, FrameRecord } from '../types/capture';

export const FRAME_STORE_LIMITS = {
    maxFrameCount: 10000000,
    maxFramesPerConnection: 1000000,
    maxTotalBytes: null as number | null,
};

interface CaptureMetaRecord {
    key: string;
    value: number;
}

/** 扩展私有数据库，由 Dexie 统一管理 schema、事务和查询。 */
const database = new Dexie('ycloud-websocket-inspector') as Dexie & {
    frames: EntityTable<FrameRecord, 'id'>;
    connections: EntityTable<ConnectionRecord, 'key'>;
    meta: EntityTable<CaptureMetaRecord, 'key'>;
};

database.version(1).stores({
    frames: 'id, connectionKey',
    connections: 'key',
    meta: 'key',
});

export const loadStoredCapture = async (): Promise<{
    frames: FrameRecord[];
    connections: ConnectionRecord[];
    generation: number;
}> => {
    return database.transaction('r', [database.frames, database.connections, database.meta], async () => {
        const [frames, connections, generationRecord] = await Promise.all([
            database.frames.orderBy('id').toArray(),
            database.connections.toArray(),
            database.meta.get('generation'),
        ]);
        return { frames, connections, generation: Number(generationRecord?.value) || 0 };
    });
};

/** 同一事务内写入新增帧并删除淘汰帧，保持容量状态一致。 */
export const persistFrameBatch = async ({
    frames,
    evictedFrameIds,
    connections,
    generation,
}: {
    frames: FrameRecord[];
    evictedFrameIds: number[];
    connections: ConnectionRecord[];
    generation: number;
}): Promise<void> => {
    if (frames.length === 0 && evictedFrameIds.length === 0 && connections.length === 0 && !Number.isFinite(generation))
        return;
    await database.transaction('rw', [database.frames, database.connections, database.meta], async () => {
        if (frames.length) await database.frames.bulkPut(frames);
        if (evictedFrameIds.length) await database.frames.bulkDelete([...new Set(evictedFrameIds)]);
        if (connections.length) await database.connections.bulkPut(connections);
        if (Number.isFinite(generation)) await database.meta.put({ key: 'generation', value: generation });
    });
};

export const persistConnections = async (connections: ConnectionRecord[]): Promise<void> => {
    if (connections.length) await database.connections.bulkPut(connections);
};

export const clearStoredConnection = async (connectionKey: string, generation: number): Promise<void> => {
    await database.transaction('rw', [database.frames, database.meta], async () => {
        await database.frames.where('connectionKey').equals(connectionKey).delete();
        await database.meta.put({ key: 'generation', value: generation });
    });
};

export const clearStoredFrames = async (generation: number): Promise<void> => {
    await database.transaction('rw', [database.frames, database.meta], async () => {
        await database.frames.clear();
        await database.meta.put({ key: 'generation', value: generation });
    });
};

export const resetStoredCapture = async (generation: number): Promise<void> => {
    await database.transaction('rw', [database.frames, database.connections, database.meta], async () => {
        await Promise.all([database.frames.clear(), database.connections.clear()]);
        await database.meta.put({ key: 'generation', value: generation });
    });
};
