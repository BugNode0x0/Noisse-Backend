export declare class NotFoundException extends Error {
    readonly status: number;
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly requestID: string;
    constructor({ code, message, path, requestID, }: {
        code?: string;
        message?: string;
        path: string;
        requestID: string;
    });
}
