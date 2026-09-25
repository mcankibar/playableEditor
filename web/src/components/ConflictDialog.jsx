import { fieldName, formatValue } from "../format.js";

/** Someone else saved the same fields meanwhile: keep mine or take theirs. */
export function ConflictDialog({ conflict, fields, onResolve }) {
  const who = conflict.server.updatedBy ? conflict.server.updatedBy : "Someone else";
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-label="Conflicting changes">
        <header>
          <strong>Conflicting changes</strong>
        </header>
        <p>
          {who} changed {conflict.conflicts.length === 1 ? "a field" : "fields"} you also changed. Your other changes
          are kept either way.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Theirs</th>
              <th>Yours</th>
            </tr>
          </thead>
          <tbody>
            {conflict.conflicts.map((c) => (
              <tr key={c.path}>
                <td>{fieldName(fields, c.path)}</td>
                <td className="mono">{formatValue(c.theirs)}</td>
                <td className="mono">{formatValue(c.yours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer>
          <button onClick={() => onResolve("theirs")}>Take theirs</button>
          <button className="primary" onClick={() => onResolve("mine")}>
            Keep mine
          </button>
        </footer>
      </div>
    </div>
  );
}
