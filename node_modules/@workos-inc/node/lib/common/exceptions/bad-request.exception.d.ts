export declare class BadRequestException extends Error {
    readonly status: number;
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly errors?: unknown[];
    readonly requestID: string;
    constructor({ code, errors, message, requestID, }: {
        code?: string;
        errors?: unknown[];
        message?: string;
        requestID: string;
    });
}
