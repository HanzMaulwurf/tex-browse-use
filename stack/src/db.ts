import postgres from 'postgres';

const url = process.env.CU_AUDIT_DATABASE_URL;

// Audit-DB ist optional: ohne CU_AUDIT_DATABASE_URL startet die Engine trotzdem.
// Audit-Writes rejecten dann (Aufrufer fangen mit .catch), /audit-Routen liefern 500.
const disabled: any = new Proxy(function () {}, {
  apply() {
    return Promise.reject(new Error('Audit disabled: CU_AUDIT_DATABASE_URL not set'));
  },
  get(_t, prop) {
    if (prop === 'then') return undefined; // not a thenable
    return disabled;
  },
});

export const sql: ReturnType<typeof postgres> = url
  ? postgres(url, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    })
  : disabled;
