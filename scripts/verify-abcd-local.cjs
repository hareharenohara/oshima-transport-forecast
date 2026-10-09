const {chromium}=require('C:/Users/6971/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const http=require('node:http');
const fs=require('node:fs');
(async()=>{
 const {handleRequest}=await import('../dist/src/worker/index.js');
 const {actionGuidance}=await import('../dist/src/pipeline/action-guidance.js');
 const services=['A','B','C','D',null].map((grade,i)=>({service_id:`fixture-${i}`,ship_type:'jet',origin:'東京',destination:'大島',service_number:String(i),scheduled_departure:`2026-10-09T${String(8+i).padStart(2,'0')}:00:00+09:00`,prediction_created_at:grade?'2026-10-09T00:00:00Z':null,evaluation_grade:grade,confidence_level:2,action_guidance:actionGuidance(grade,'abcd-v1'),assessment:grade?'風速・波高の予報から判定。注意点と次回更新を確認してください。':null}));
 const days=['A','B','C','D',null].map((grade,i)=>({date:`2026-10-${String(9+i).padStart(2,'0')}`,services,group_forecasts:[],daily_forecast:grade?{assessment:{evaluation_grade:grade,assessment:'風と波の予報を比較した見通しです。対象便の注意点をご確認ください。'},action_guidance:actionGuidance(grade,'abcd-v1')}:null,ai_update_status:grade?'ok':'failed'}));
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');let response;
  if(url.pathname==='/api/days')response=Response.json({days});
  else if(url.pathname.endsWith('/history'))response=Response.json({history:['B','A'].map((grade,i)=>({evaluation_rating:grade,ai_status:'generated',published_at:`2026-10-09T0${i}:00:00Z`,action_guidance:actionGuidance(grade,'abcd-v1')}))});
  else if(url.pathname.endsWith('/series'))response=Response.json({}, {status:404});
  else if(url.pathname.startsWith('/api/services/'))response=Response.json({service:services.find(s=>s.service_id===url.pathname.split('/').at(-1))});
  else response=await handleRequest(new Request(url));
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:375,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
  if(await page.locator('.day-summary .grade-status').count())throw Error('Collapsed card must only contain segments');
  await page.screenshot({path:'outputs/segment-compact-375.png',fullPage:true});
  await page.locator('.day-summary').first().click();
  const overview=page.locator('.day.open .daily-overview');
  if(await overview.locator('.grade-badge').innerText()!=='良好'||!(await overview.locator('.grade-comment').innerText()).includes('風と波の予報を比較'))throw Error('Expanded overview must combine grade and comment');
  if(await overview.locator('h3').count())throw Error('Overview label must be the grade');
  const gauges=await page.locator('.day-summary .grade-gauge').evaluateAll(nodes=>nodes.map(el=>({grade:el.dataset.grade,nodes:el.querySelectorAll('.grade-segment').length,labels:[...el.querySelectorAll('.grade-segment')].map(s=>s.textContent),selected:[...el.querySelectorAll('.grade-segment.active')].map(s=>s.dataset.grade)})));
  if(gauges.some(g=>g.nodes!==4||g.labels.join(',')!=='困難,注意,見込,良好'||g.selected.join('')!==(g.grade==='pending'?'':g.grade))||gauges.map(g=>g.grade).join('')!=='ABCDpending')throw Error('Four-grade guidance missing');
  const names=await page.locator('.day.open .service-grade').allTextContents();
  if(names.join(',')!=='良好,見込,注意,困難,--')throw Error('Japanese badge labels missing');
  const positions=await page.locator('.day.open .service-grade').evaluateAll(nodes=>nodes.map(el=>({label:el.textContent,width:el.clientWidth,overflow:el.scrollWidth>el.clientWidth,color:getComputedStyle(el).backgroundColor})));
  if(positions.some(item=>item.overflow))throw Error('Two-character badge overflow');
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
  await page.screenshot({path:'outputs/abcd-local-375.png',fullPage:true});
  for(const width of [320,768]){
   await page.setViewportSize({width,height:900});
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Segment overflow at '+width);
  }
  await page.setViewportSize({width:375,height:900});
  await page.locator('#theme').click();
  await page.screenshot({path:'outputs/segment-dark-375.png',fullPage:true});
  await page.locator('#theme').click();
  await page.locator('[data-service="fixture-1"]').first().click();
  await page.locator('#detail .history-panel svg').waitFor();
  const historyLabels=await page.locator('#detail .history-panel .chart-label').allTextContents();
  if(historyLabels.slice(0,4).join(',')!=='困難,注意,見込,良好')throw Error('Japanese history labels missing');
  if(await page.locator('#detail .grade-status .grade-badge').innerText()!=='見込')throw Error('Japanese detail badge missing');
  await page.screenshot({path:'outputs/japanese-grade-detail-375.png'});
  await page.locator('#sheet .close[data-close]').click();
  await page.locator('[data-service="fixture-4"]').first().click();
  await page.locator('#detail .grade-gauge').waitFor();
  const detail=await page.locator('#detail').innerText();
  if(await page.locator('#detail .grade-gauge').getAttribute('data-grade')!=='pending'||detail.includes('慎重側'))throw Error('Missing data was forced into a grade');
  await page.screenshot({path:'outputs/abcd-local-detail-375.png'});
  if(errors.length)throw Error(errors.join('\n'));
  fs.writeFileSync('outputs/abcd-local-verification.json',JSON.stringify({fixture:true,viewport:375,gauges,positions,historyLabels,errors,missingDataDetail:detail},null,2));
  console.log(JSON.stringify({gauges,positions,historyLabels,errors,missingDataNotForced:true}));
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
