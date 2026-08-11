// ======================================================
// ABRAVANEL VISITOR TRACKER
// /js/tracker.js
//
// Envia:
// - ID anônimo da sessão
// - entrada
// - última atividade
// - página atual
// - duração
// - status online/offline
//
// Endpoint:
// /.netlify/functions/visitors
// ======================================================

(() => {

    "use strict";


    // ==================================================
    // CONFIG
    // ==================================================

    const CONFIG = {

        endpoint:
            "/.netlify/functions/visitors",

        // Heartbeat a cada 20 segundos
        heartbeatInterval:
            20000,

        // Movimento/clique não envia request imediatamente.
        // Apenas atualiza atividade local.
        activityThrottle:
            3000
    };


    // ==================================================
    // SESSION
    // ==================================================

    const SESSION_KEY =
        "abravanel_visitor_session";


    let sessionId =
        sessionStorage.getItem(
            SESSION_KEY
        );


    if (!sessionId) {

        sessionId =
            createSessionId();


        sessionStorage.setItem(
            SESSION_KEY,
            sessionId
        );
    }


    const startedAt =
        Date.now();


    let lastActivity =
        Date.now();


    let lastActivityEvent =
        0;


    let heartbeatTimer =
        null;


    let sessionEnded =
        false;



    // ==================================================
    // ID ANÔNIMO
    // ==================================================

    function createSessionId() {

        if (
            window.crypto &&
            crypto.randomUUID
        ) {

            return crypto.randomUUID();
        }


        return (
            "visitor-" +
            Date.now().toString(36) +
            "-" +
            Math.random()
                .toString(36)
                .substring(2, 12)
        );
    }



    // ==================================================
    // TEMPO
    // ==================================================

    function getDurationSeconds() {

        return Math.max(
            0,
            Math.floor(
                (
                    Date.now() -
                    startedAt
                ) / 1000
            )
        );
    }



    // ==================================================
    // URL/PÁGINA
    // ==================================================

    function getCurrentPage() {

        return (
            window.location.pathname +
            window.location.search
        );
    }



    // ==================================================
    // PAYLOAD
    // ==================================================

    function buildPayload(action) {

        return {

            action:
                action,

            sessionId:
                sessionId,

            page:
                getCurrentPage(),

            startedAt:
                new Date(
                    startedAt
                ).toISOString(),

            lastActivity:
                new Date(
                    lastActivity
                ).toISOString(),

            durationSeconds:
                getDurationSeconds(),

            visibility:
                document.visibilityState,

            timestamp:
                new Date()
                .toISOString()

        };
    }



    // ==================================================
    // POST NORMAL
    // ==================================================

    async function sendEvent(
        action
    ) {

        if (
            sessionEnded &&
            action !== "end"
        ) {

            return;
        }


        try {

            const response =
                await fetch(
                    CONFIG.endpoint,
                    {

                        method:
                            "POST",

                        headers: {

                            "Content-Type":
                                "application/json"

                        },

                        body:
                            JSON.stringify(
                                buildPayload(
                                    action
                                )
                            ),

                        keepalive:
                            true
                    }
                );


            if (!response.ok) {

                console.warn(
                    "[TRACKER] HTTP",
                    response.status
                );
            }


        } catch (error) {

            /*
                Tracker nunca deve quebrar
                o site caso a Function
                esteja offline.
            */

            console.warn(
                "[TRACKER] endpoint indisponível"
            );
        }
    }



    // ==================================================
    // SEND BEACON
    //
    // Mais confiável quando usuário
    // fecha a página.
    // ==================================================

    function sendBeaconEvent(
        action
    ) {

        try {

            const payload =
                JSON.stringify(
                    buildPayload(
                        action
                    )
                );


            const blob =
                new Blob(
                    [payload],
                    {
                        type:
                            "application/json"
                    }
                );


            if (
                navigator.sendBeacon
            ) {

                navigator.sendBeacon(
                    CONFIG.endpoint,
                    blob
                );


                return;
            }


            /*
                Fallback
            */

            fetch(
                CONFIG.endpoint,
                {

                    method:
                        "POST",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        payload,

                    keepalive:
                        true
                }
            )
            .catch(() => {});


        } catch (error) {

            // Ignora erro de encerramento.
        }
    }



    // ==================================================
    // ATIVIDADE
    // ==================================================

    function registerActivity() {

        const now =
            Date.now();


        /*
            Evita atualizar centenas
            de vezes por segundo
            durante mousemove.
        */

        if (
            now -
            lastActivityEvent <
            CONFIG.activityThrottle
        ) {

            return;
        }


        lastActivityEvent =
            now;


        lastActivity =
            now;
    }



    // ==================================================
    // HEARTBEAT
    // ==================================================

    function heartbeat() {

        if (
            document.visibilityState ===
            "visible"
        ) {

            sendEvent(
                "heartbeat"
            );
        }
    }



    function startHeartbeat() {

        if (
            heartbeatTimer
        ) {

            clearInterval(
                heartbeatTimer
            );
        }


        heartbeatTimer =
            setInterval(
                heartbeat,
                CONFIG.heartbeatInterval
            );
    }



    // ==================================================
    // VISIBILITY
    // ==================================================

    function visibilityChanged() {

        registerActivity();


        if (
            document.visibilityState ===
            "visible"
        ) {

            sendEvent(
                "resume"
            );

        } else {

            sendEvent(
                "hidden"
            );
        }
    }



    // ==================================================
    // FINAL DA SESSÃO
    // ==================================================

    function endSession() {

        if (
            sessionEnded
        ) {

            return;
        }


        sessionEnded =
            true;


        if (
            heartbeatTimer
        ) {

            clearInterval(
                heartbeatTimer
            );
        }


        sendBeaconEvent(
            "end"
        );
    }



    // ==================================================
    // EVENTOS DO USUÁRIO
    // ==================================================

    const activityEvents = [

        "mousemove",
        "mousedown",
        "keydown",
        "touchstart",
        "scroll"

    ];


    activityEvents.forEach(
        eventName => {

            window.addEventListener(
                eventName,
                registerActivity,
                {
                    passive:
                        true
                }
            );

        }
    );



    // ==================================================
    // TROCA DE ABA
    // ==================================================

    document.addEventListener(
        "visibilitychange",
        visibilityChanged
    );



    // ==================================================
    // SAÍDA
    // ==================================================

    window.addEventListener(
        "pagehide",
        endSession
    );



    // ==================================================
    // START
    // ==================================================

    async function init() {

        console.log(
            "[TRACKER] sessão iniciada:",
            sessionId
        );


        await sendEvent(
            "start"
        );


        startHeartbeat();
    }



    if (
        document.readyState ===
        "loading"
    ) {

        document.addEventListener(
            "DOMContentLoaded",
            init,
            {
                once:
                    true
            }
        );

    } else {

        init();
    }


    // ==================================================
    // DEBUG LOCAL
    //
    // Pode remover depois.
    // ==================================================

    window.AbravanelTracker = {

        getSession() {

            return {

                sessionId:
                    sessionId,

                startedAt:
                    new Date(
                        startedAt
                    ).toISOString(),

                lastActivity:
                    new Date(
                        lastActivity
                    ).toISOString(),

                durationSeconds:
                    getDurationSeconds(),

                page:
                    getCurrentPage()

            };
        },


        ping() {

            return sendEvent(
                "heartbeat"
            );
        }

    };

})();
