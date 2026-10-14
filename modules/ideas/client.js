// Ideas board module, in the station panel: the link to the board in the header, shown only to whoever may use the
// board (in the organization or in at least one room). The board itself is the module's page (page.html with
// ideas.js), served at /m/ideas (and /ideas).
export default function mount(station) {
  const link = station.el('a', 'btn ghost', station.__('💡 IDEAS'));
  link.href = '/m/ideas';
  link.title = station.__('Ideas board: for you humans only');
  link.hidden = true;
  station.slot('header').append(link);
  station.on('state', (s) => {
    link.hidden = !station.can(s.organizationMe, 'ideas.use') && !(s.rooms || []).some((r) => r.permissions?.includes('ideas.use'));
  });
}
