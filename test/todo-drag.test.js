const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const T=require('../public/todo-core');
test('desktop lanes stretch to the tallest overflowing card stack instead of ending at the viewport',()=>{
  const css=fs.readFileSync(require.resolve('../public/todo.css'),'utf8');
  assert.match(css,/grid-auto-rows:minmax\(max-content,1fr\)/);
  assert.match(css,/@media\(max-width:760px\).*grid-auto-rows:max-content/);
});
function harness(){
  const nodes=new Map(),frames=new Map(),saved=[],notices=[];let sequence=0;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',events:{},addEventListener(type,fn){this.events[type]=fn;},querySelectorAll:()=>[],classList:{add(){},remove(){}}});return nodes.get(id);};
  const board=node('todoView');Object.assign(board,{scrollTop:500,scrollLeft:0,scrollHeight:1800,clientHeight:400,getBoundingClientRect:()=>({left:100,right:900,top:100,bottom:500})});
  const lane={dataset:{lane:'Done'},classList:{add(){},remove(){}},closest:selector=>selector==='[data-lane]'?lane:null};
  const card={dataset:{card:'todo_a'},classList:{add(){}},closest:selector=>selector==='[data-card]'?card:null};
  const window={PipeChatTodo:T,innerHeight:800,addEventListener(){},requestAnimationFrame(fn){const id=++sequence;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/todo-ui'),'utf8'),{window,document:{getElementById:node,addEventListener(){},elementFromPoint:()=>lane}});
  const S={loaded:true,revision:3,generation:1,records:[{id:1,account:'Account'}],tableSchema:null,todoCards:[{...T.create('todo_a',1),nextAction:'QA task',dueDate:'2026-10-01'}]};
  const ui=window.PipeChatTodoUI.create({S,esc:v=>String(v).replaceAll('<','&lt;').replaceAll('>','&gt;'),icon:()=>'',persistTodo:async cards=>saved.push(cards),prepare(){},render(){},toast:message=>notices.push(message),localDate:()=> '2026-09-26'});
  function event(target,y=490){return {target,clientX:750,clientY:y,preventDefault(){this.prevented=true;},dataTransfer:{setData(){}}};}
  return {board,card,lane,S,frames,saved,notices,ui,node,event,step(){const [id,fn]=frames.entries().next().value;frames.delete(id);fn();}};
}
test('dragging a scrolled board scrolls at its edge and accepts a drop anywhere in a destination lane',()=>{
  const h=harness();h.board.events.dragstart(h.event(h.card));const over=h.event(h.lane);h.board.events.dragover(over);assert(over.prevented);h.step();assert(h.board.scrollTop>500);
  const before=structuredClone(h.S.todoCards);h.board.events.drop(h.event(h.lane));assert.equal(h.frames.size,0);assert.equal(h.saved.length,1);assert.equal(h.saved[0][0].status,'Done');assert.equal(h.saved[0][0].dueDate,before[0].dueDate);assert.deepEqual(h.S.todoCards,before);
});
test('stale drag, pending proposal and drag end do not write or leave scrolling active',()=>{
  const h=harness();h.board.events.dragstart(h.event(h.card));h.board.events.dragover(h.event(h.lane));h.S.revision++;h.board.events.drop(h.event(h.lane));assert.equal(h.saved.length,0);assert.match(h.notices[0],/board changed/);assert.equal(h.frames.size,0);
  h.S.pending={};const start=h.event(h.card);h.board.events.dragstart(start);assert(start.prevented);h.board.events.drop(h.event(h.lane));assert.equal(h.saved.length,0);
  h.S.pending=null;h.board.events.dragstart(h.event(h.card));h.board.events.dragover(h.event(h.lane));h.board.events.dragend();assert.equal(h.frames.size,0);
});
test('bulk preview names every changed card and transition with one confirmation, safely escaped',()=>{
  const h=harness();h.S.todoCards.push({...T.create('todo_b',null,'<unsafe>'),nextAction:'Second task',status:'In Progress'});
  h.ui.preview(T.plan(h.S.todoCards,h.S.records,null,[],{action:'move_todos',todoMoves:h.S.todoCards.map(c=>({todoId:c.id,todoStatus:'Done'}))}));
  const html=h.node('trustBody').innerHTML;for(const text of ['2 cards to move','Account','QA task','Second task','To Do &rarr; Done','In Progress &rarr; Done','&lt;unsafe&gt;','Confirm 2 moves'])assert(html.includes(text));assert.equal((html.match(/data-confirm/g)||[]).length,1);
});
