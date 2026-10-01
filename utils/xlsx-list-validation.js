'use strict';

/*
 * In-cell dropdowns for import templates: a hidden "Lists" sheet holds each
 * vocabulary in its own column, and the data sheet's column gets Excel list
 * validation pointing at it — so a typo is refused by Excel itself, before the
 * file is ever uploaded. UX sugar ON TOP of the importer's own validation,
 * never instead of it (a file can come from anywhere).
 *
 * lists: [{ column: 'B', title: 'Categories', names: [...], allowBlank, error }]
 *   column = the DATA sheet column the dropdown applies to. A list with no
 *   names gets no validation (an empty dropdown would block every value).
 */
const TEMPLATE_LAST_DATA_ROW = 1000;

function addListValidations(wb, sheetName, firstDataRow, lists, lastRow = TEMPLATE_LAST_DATA_ROW) {
  const listsWs = wb.addWorksheet('Lists', { state: 'hidden' });
  const ws = wb.getWorksheet(sheetName);
  lists.forEach((l, i) => {
    const listCol = String.fromCharCode(65 + i); // Lists sheet column: A, B, C…
    listsWs.getColumn(i + 1).values = [l.title, ...l.names];
    if (!l.names.length) return;
    ws.dataValidations.add(`${l.column}${firstDataRow}:${l.column}${lastRow}`, {
      type: 'list', allowBlank: !!l.allowBlank,
      formulae: [`Lists!$${listCol}$2:$${listCol}$${l.names.length + 1}`],
      showErrorMessage: true, errorTitle: `Unknown ${l.title.replace(/s$/, '').toLowerCase()}`, error: l.error,
    });
  });
}

module.exports = { addListValidations, TEMPLATE_LAST_DATA_ROW };
