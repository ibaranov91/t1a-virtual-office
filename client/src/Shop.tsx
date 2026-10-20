// The 7/11 shelves: everything is free, SHOP_DAILY_MAX things per person per office day (the server counts; shared/shop.ts has the rules).
import { Icon } from './Icon';
import type { Store } from './net';
import { itemDef } from '../../shared/items';
import { SHOP_DAILY_MAX, shopStock } from '../../shared/shop';

export function ShopPanel({ store }: { store: Store }) {
  const left = Math.max(0, SHOP_DAILY_MAX - store.shopTaken.length), close = () => store.openShop(false);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="meet-panel guided shop-panel" role="dialog" aria-label="7/11 shelves">
      <div className="rooms-head"><span>7/11 · free today</span><button type="button" className="ghost" aria-label="Close" onClick={close}><Icon name="close" /></button></div>
      <p className="hint">{left ? `Take up to ${left} more today. Everything is on the house.` : 'That is your last one today. See you tomorrow.'}</p>
      <ul className="shop-list">
        {shopStock().map(d => {
          const n = store.shopTaken.filter(i => i === d.id).length;
          return <li key={d.id}>
            <span className="shop-icon" aria-hidden>{d.icon}</span>
            <span className="shop-name">{d.label}{n > 0 && <small> · {n} taken</small>}</span>
            <button type="button" disabled={!left} onClick={() => store.takeFromShop(d.id)}>Take</button>
          </li>;
        })}
      </ul>
      {store.shopTaken.length > 0 && <p className="hint">Taken today: {store.shopTaken.map(i => itemDef(i)?.icon ?? i).join(' ')}</p>}
    </div>
  </div>;
}
