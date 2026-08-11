// ======================================================
// ABRAVANEL VISITOR API
// /netlify/functions/visitors.mjs
//
// POST = recebe tracker.js
// GET  = painel ADM consulta visitantes
//
// NÃO coleta IP.
// ======================================================

import { getStore } from "@netlify/blobs";


// ======================================================
// CONFIG
// ======================================================

const STORE_NAME = "visitor-sessions";

/*
    O tracker manda heartbeat a cada 20 segundos.

    Se ficar mais de 65 segundos sem sinal,
    consideramos offline.
*/
const ONLINE_TIMEOUT_MS = 65 * 1000;

const MAX_PAGE_LENGTH = 500;
const MAX_SESSION_LENGTH = 120;

const ALLOWED_ACTIONS = new Set([
    "start",
    "heartbeat",
    "hidden",
    "resume",
    "end"
]);


// ======================================================
// STORE
// ======================================================

function getVisitorStore() {

    return getStore({
        name: STORE_NAME,
        consistency: "strong"
    });
}


// ======================================================
// JSON RESPONSE
// ======================================================

function json(data, status = 200) {

    return new Response(
        JSON.stringify(data),
        {
            status,

            headers: {
                "Content-Type":
                    "application/json; charset=utf-8",

                "Cache-Control":
                    "no-store"
            }
        }
    );
}


// ======================================================
// SANITIZA SESSION ID
// ======================================================

function cleanSessionId(value) {

    if (
        typeof value !== "string"
    ) {
        return "";
    }

    return value
        .trim()
        .replace(
            /[^a-zA-Z0-9._-]/g,
            ""
        )
        .slice(
            0,
            MAX_SESSION_LENGTH
        );
}


// ======================================================
// SANITIZA PÁGINA
// ======================================================

function cleanPage(value) {

    if (
        typeof value !== "string"
    ) {
        return "/";
    }

    let page =
        value
        .trim()
        .slice(
            0,
            MAX_PAGE_LENGTH
        );

    if (!page) {
        page = "/";
    }

    return page;
}


// ======================================================
// ISO DATE SEGURA
// ======================================================

function cleanISODate(value) {

    if (!value) {
        return null;
    }

    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return null;
    }

    return date.toISOString();
}


// ======================================================
// AUTENTICAÇÃO DO GET ADMIN
// ======================================================

function adminAuthorized(request) {

    const configuredUser =
        process.env.ADMIN_USER;

    const configuredPassword =
        process.env.ADMIN_PASSWORD;


    if (
        !configuredUser ||
        !configuredPassword
    ) {
        return false;
    }


    const user =
        request.headers.get(
            "x-admin-user"
        );

    const password =
        request.headers.get(
            "x-admin-password"
        );


    return (
        user === configuredUser &&
        password === configuredPassword
    );
}


// ======================================================
// CALCULAR STATUS
// ======================================================

function calculateSessionStatus(
    session,
    nowMs
) {

    if (
        session.endedAt ||
        session.lastAction === "end"
    ) {

        return {
            online: false,
            status: "offline"
        };
    }


    const lastSeen =
        new Date(
            session.lastSeen
        ).getTime();


    if (
        Number.isNaN(
            lastSeen
        )
    ) {

        return {
            online: false,
            status: "offline"
        };
    }


    const difference =
        nowMs -
        lastSeen;


    if (
        difference <=
        ONLINE_TIMEOUT_MS
    ) {

        return {
            online: true,

            status:
                session.visibility ===
                "hidden"
                ? "away"
                : "online"
        };
    }


    return {
        online: false,
        status: "offline"
    };
}


// ======================================================
// CALCULAR DURAÇÃO
// ======================================================

function calculateDuration(
    session,
    nowMs
) {

    const started =
        new Date(
            session.startedAt
        ).getTime();


    if (
        Number.isNaN(
            started
        )
    ) {
        return 0;
    }


    let endTime =
        nowMs;


    if (
        session.endedAt
    ) {

        const ended =
            new Date(
                session.endedAt
            ).getTime();


        if (
            !Number.isNaN(
                ended
            )
        ) {

            endTime =
                ended;
        }

    } else {

        const lastSeen =
            new Date(
                session.lastSeen
            ).getTime();


        const status =
            calculateSessionStatus(
                session,
                nowMs
            );


        /*
            Se está offline por timeout,
            duração termina no último sinal.
        */

        if (
            !status.online &&
            !Number.isNaN(
                lastSeen
            )
        ) {

            endTime =
                lastSeen;
        }
    }


    return Math.max(
        0,

        Math.floor(
            (
                endTime -
                started
            ) / 1000
        )
    );
}


// ======================================================
// POST
// TRACKER → FUNCTION
// ======================================================

async function handlePost(
    request
) {

    let body;


    try {

        body =
            await request.json();

    } catch {

        return json(
            {
                success: false,
                error: "JSON inválido."
            },
            400
        );
    }


    // ==================================================
    // VALIDAR SESSION
    // ==================================================

    const sessionId =
        cleanSessionId(
            body.sessionId
        );


    if (
        !sessionId ||
        sessionId.length < 5
    ) {

        return json(
            {
                success: false,
                error:
                    "Session ID inválido."
            },
            400
        );
    }


    // ==================================================
    // VALIDAR ACTION
    // ==================================================

    const action =
        String(
            body.action || ""
        )
        .trim()
        .toLowerCase();


    if (
        !ALLOWED_ACTIONS.has(
            action
        )
    ) {

        return json(
            {
                success: false,
                error:
                    "Evento inválido."
            },
            400
        );
    }


    const store =
        getVisitorStore();


    const key =
        "session/" +
        sessionId;


    const now =
        new Date();


    const nowISO =
        now.toISOString();


    // ==================================================
    // BUSCAR SESSÃO EXISTENTE
    // ==================================================

    let existing = null;


    try {

        existing =
            await store.get(
                key,
                {
                    type: "json",
                    consistency: "strong"
                }
            );

    } catch (error) {

        console.error(
            "Erro lendo sessão:",
            error
        );
    }


    // ==================================================
    // STARTED AT
    //
    // O servidor mantém o primeiro horário.
    // Não deixa refresh zerar a duração.
    // ==================================================

    let startedAt =
        existing?.startedAt ||
        cleanISODate(
            body.startedAt
        ) ||
        nowISO;


    /*
        Segurança:
        data inicial futura não faz sentido.
    */

    if (
        new Date(
            startedAt
        ).getTime() >
        now.getTime()
    ) {

        startedAt =
            nowISO;
    }


    // ==================================================
    // LAST ACTIVITY DO CLIENTE
    // ==================================================

    const clientActivity =
        cleanISODate(
            body.lastActivity
        );


    // ==================================================
    // VISIBILITY
    // ==================================================

    const visibility =
        body.visibility === "hidden"
        ? "hidden"
        : "visible";


    // ==================================================
    // END
    // ==================================================

    let endedAt =
        existing?.endedAt ||
        null;


    /*
        Se houve novo start/resume,
        sessão volta a ativa.
    */

    if (
        action === "start" ||
        action === "resume" ||
        action === "heartbeat"
    ) {

        endedAt =
            null;
    }


    if (
        action === "end"
    ) {

        endedAt =
            nowISO;
    }


    // ==================================================
    // REGISTRO
    // ==================================================

    const record = {

        sessionId:
            sessionId,

        page:
            cleanPage(
                body.page
            ),

        startedAt:
            startedAt,

        lastSeen:
            nowISO,

        lastActivity:
            clientActivity ||
            existing?.lastActivity ||
            nowISO,

        endedAt:
            endedAt,

        lastAction:
            action,

        visibility:
            visibility,

        eventCount:
            (
                Number(
                    existing?.eventCount
                ) || 0
            ) + 1,

        updatedAt:
            nowISO
    };


    // ==================================================
    // SALVAR
    // ==================================================

    try {

        await store.setJSON(
            key,
            record,
            {
                metadata: {

                    lastSeen:
                        nowISO,

                    action:
                        action
                }
            }
        );


    } catch (error) {

        console.error(
            "Erro salvando visitante:",
            error
        );


        return json(
            {
                success: false,

                error:
                    "Não foi possível salvar sessão."
            },
            500
        );
    }


    // ==================================================
    // OK
    // ==================================================

    return json({

        success:
            true,

        sessionId:
            sessionId,

        action:
            action,

        serverTime:
            nowISO

    });
}


// ======================================================
// GET
// ADM → CONSULTAR VISITANTES
// ======================================================

async function handleGet(
    request
) {

    // ==================================================
    // PROTEGER LISTA
    // ==================================================

    if (
        !adminAuthorized(
            request
        )
    ) {

        return json(
            {
                success: false,
                error:
                    "Não autorizado."
            },
            401
        );
    }


    const store =
        getVisitorStore();


    const url =
        new URL(
            request.url
        );


    // ==================================================
    // LIMIT
    // ==================================================

    let limit =
        parseInt(
            url.searchParams.get(
                "limit"
            ) || "100",
            10
        );


    if (
        Number.isNaN(
            limit
        )
    ) {

        limit = 100;
    }


    limit =
        Math.min(
            Math.max(
                limit,
                1
            ),
            500
        );


    // ==================================================
    // ONLINE ONLY
    // ?online=1
    // ==================================================

    const onlineOnly =
        url.searchParams.get(
            "online"
        ) === "1";


    // ==================================================
    // LISTAR BLOBS
    // ==================================================

    let blobs;


    try {

        const result =
            await store.list({
                prefix:
                    "session/"
            });


        blobs =
            result.blobs ||
            [];


    } catch (error) {

        console.error(
            "Erro listando sessões:",
            error
        );


        return json(
            {
                success: false,
                error:
                    "Não foi possível listar visitantes."
            },
            500
        );
    }


    // ==================================================
    // LER CADA SESSÃO
    // ==================================================

    const records =
        await Promise.all(

            blobs.map(
                async blob => {

                    try {

                        return await store.get(
                            blob.key,
                            {
                                type: "json",
                                consistency: "strong"
                            }
                        );

                    } catch {

                        return null;
                    }

                }
            )
        );


    const nowMs =
        Date.now();


    // ==================================================
    // PREPARAR RESULTADO
    // ==================================================

    let sessions =
        records

        .filter(Boolean)

        .map(
            session => {

                const state =
                    calculateSessionStatus(
                        session,
                        nowMs
                    );


                const lastSeenMs =
                    new Date(
                        session.lastSeen
                    )
                    .getTime();


                return {

                    sessionId:
                        session.sessionId,

                    page:
                        session.page,

                    startedAt:
                        session.startedAt,

                    lastSeen:
                        session.lastSeen,

                    lastActivity:
                        session.lastActivity,

                    endedAt:
                        session.endedAt,

                    lastAction:
                        session.lastAction,

                    visibility:
                        session.visibility,

                    online:
                        state.online,

                    status:
                        state.status,

                    durationSeconds:
                        calculateDuration(
                            session,
                            nowMs
                        ),

                    secondsSinceLastSeen:
                        Number.isNaN(
                            lastSeenMs
                        )
                        ? null
                        : Math.max(
                            0,

                            Math.floor(
                                (
                                    nowMs -
                                    lastSeenMs
                                ) / 1000
                            )
                        ),

                    eventCount:
                        session.eventCount ||
                        0
                };
            }
        );


    // ==================================================
    // ONLINE ONLY
    // ==================================================

    if (
        onlineOnly
    ) {

        sessions =
            sessions.filter(
                session =>
                    session.online
            );
    }


    // ==================================================
    // ORDENA:
    //
    // online primeiro
    // depois atividade recente
    // ==================================================

    sessions.sort(
        (a, b) => {

            if (
                a.online !==
                b.online
            ) {

                return a.online
                    ? -1
                    : 1;
            }


            return (
                new Date(
                    b.lastSeen
                ).getTime() -

                new Date(
                    a.lastSeen
                ).getTime()
            );
        }
    );


    const onlineCount =
        sessions.filter(
            session =>
                session.online
        ).length;


    const totalBeforeLimit =
        sessions.length;


    sessions =
        sessions.slice(
            0,
            limit
        );


    // ==================================================
    // RETURN
    // ==================================================

    return json({

        success:
            true,

        serverTime:
            new Date()
            .toISOString(),

        onlineTimeoutSeconds:
            ONLINE_TIMEOUT_MS /
            1000,

        onlineCount:
            onlineCount,

        total:
            totalBeforeLimit,

        returned:
            sessions.length,

        sessions:
            sessions

    });
}


// ======================================================
// FUNCTION PRINCIPAL
// ======================================================

export default async (
    request
) => {

    try {

        if (
            request.method === "POST"
        ) {

            return await handlePost(
                request
            );
        }


        if (
            request.method === "GET"
        ) {

            return await handleGet(
                request
            );
        }


        return json(
            {
                success: false,

                error:
                    "Método não permitido."
            },
            405
        );


    } catch (error) {

        console.error(
            "VISITOR FUNCTION ERROR:",
            error
        );


        return json(
            {
                success: false,

                error:
                    "Erro interno."
            },
            500
        );
    }
};
