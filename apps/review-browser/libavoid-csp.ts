import { createHash } from "node:crypto";

const browserDistributionSha256 =
  "b37ef71a879c786edd03895891a55df2288427ce21f3a00e79e92e9ade205c16";

const embindWrapper = `function Oe(e,t,r,n,i,o){
  if(t.length<2)throw new m("argTypes array size mismatch! Must at least get return value and 'this' types!");
  d(!o,"Async bindings are only supported with JSPI.");
  const hasThis=t[1]!==null&&r!==null;
  const needsDestructors=$t(t);
  const returnType=t[0];
  const returnsValue=returnType.name!=="void";
  const classType=t[1];
  const argumentTypes=t.slice(2);
  const maxArgs=argumentTypes.length;
  let minArgs=maxArgs;
  while(minArgs>0&&argumentTypes[minArgs-1].optional)minArgs--;
  const destructorTypes=needsDestructors?[]:t.slice(hasThis?1:2).map(type=>type.s);
  const wrapper=function(...args){
    cr(args.length,minArgs,maxArgs,e,Qt);
    const destructors=needsDestructors?[]:null;
    const wired=[];
    if(hasThis)wired.push(classType.toWireType(destructors,this));
    for(let index=0;index<maxArgs;index++){
      wired.push(argumentTypes[index].toWireType(destructors,args[index]));
    }
    const result=n(i,...wired);
    if(needsDestructors){
      ke(destructors);
    }else{
      for(let index=0;index<destructorTypes.length;index++){
        const destructor=destructorTypes[index];
        if(destructor!==null)destructor(wired[index]);
      }
    }
    if(returnsValue)return returnType.fromWireType(result);
  };
  Object.defineProperty(wrapper,"length",{value:maxArgs});
  return _e(e,wrapper);
}`;

const emvalMethodCaller = `_emval_get_method_caller:(e,t,r)=>{
  const types=Tr(e,t);
  const returnType=types.shift();
  const returnsValue=!returnType.W;
  const offsets=[];
  let offset=0;
  for(const type of types){
    offsets.push(offset);
    offset+=type.o;
  }
  const caller=function(obj,func,destructorsRef,args){
    const values=types.map((type,index)=>type.readValueFromPointer(args+offsets[index]));
    let result;
    if(r===1){
      result=Reflect.construct(func,values);
    }else{
      if(r===0)values.unshift(obj);
      result=func.call(...values);
    }
    if(returnsValue)return Er(returnType,destructorsRef,result);
  };
  const name="methodCaller<("+types.map(type=>type.name).join(", ")+") => "+returnType.name+">";
  return _r(_e(name,caller));
},`;

export function makeLibavoidCspSafe(source: string): string {
  if (
    createHash("sha256").update(source).digest("hex") !==
    browserDistributionSha256
  ) {
    throw new Error(
      "Unsupported libavoid-js browser distribution: re-audit the CSP bindings before updating the pinned 0.5.0-beta.5 build.",
    );
  }

  const replacements = [
    ["function Oe(e,t,r,n,i,o){", "for(var xe=", embindWrapper],
    ["_emval_get_method_caller:", "_emval_incref:", emvalMethodCaller],
  ];

  for (const [start, end, replacement] of replacements) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);

    if (
      from < 0 ||
      to < 0 ||
      source.indexOf(start, from + start.length) !== -1 ||
      source.indexOf(end, to + end.length) !== -1 ||
      source.slice(from, to).split("new Function(").length !== 2
    ) {
      throw new Error(
        "Unexpected libavoid-js CSP generator boundary or count.",
      );
    }

    source = source.slice(0, from) + replacement + source.slice(to);
  }

  if (/\b(?:eval|Function)\s*\(/.test(source)) {
    throw new Error(
      "Dynamic JavaScript compilation remains in libavoid-js after CSP hardening.",
    );
  }

  return source;
}
