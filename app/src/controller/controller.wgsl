struct State {
    viewport: vec4<f32>,
    sticks: vec4<f32>,
    geometry: array<vec4<f32>, 16>,
    flags: array<vec4<f32>, 16>,
}
@group(0) @binding(0) var<uniform> state: State;

@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let corners = array<vec2<f32>, 3>(vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
    return vec4(corners[index], 0., 1.);
}
fn box(p: vec2<f32>, half: vec2<f32>, radius: f32) -> f32 {
    let q = abs(p) - half + radius;
    return length(max(q, vec2(0.))) + min(max(q.x, q.y), 0.) - radius;
}
fn capsule(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let ba = b-a; let pa = p-a;
    return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.))-r;
}
fn smooth_union(a: f32, b: f32, k: f32) -> f32 {
    let h=clamp(0.5+0.5*(b-a)/k,0.,1.);
    return mix(b,a,h)-k*h*(1.-h);
}
fn body(p: vec2<f32>) -> f32 {
    var d=box(p-vec2(500.,284.),vec2(210.,84.),40.);
    d=smooth_union(d,length(p-vec2(270.,267.))-108.,32.);
    d=smooth_union(d,length(p-vec2(730.,267.))-108.,32.);
    d=smooth_union(d,capsule(p,vec2(260.,300.),vec2(207.,434.),62.),35.);
    d=smooth_union(d,capsule(p,vec2(740.,300.),vec2(793.,434.),62.),35.);
    d=smooth_union(d,length(p-vec2(385.,365.))-65.,28.);
    return smooth_union(d,length(p-vec2(615.,365.))-65.,28.);
}
fn coverage(d: f32, aa: f32) -> f32 { return 1.-smoothstep(-aa,aa,d); }
fn line(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 { return capsule(p,a,b,1.7); }
@fragment fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let p=position.xy/state.viewport.xy*vec2(1000.,580.);
    let aa=1000./state.viewport.x;
    let radial=exp(-dot((p-vec2(500.,285.))/vec2(420.,300.),(p-vec2(500.,285.))/vec2(420.,300.)));
    var color=vec3(0.044,0.065,0.09)+vec3(0.02,0.026,0.031)*radial;
    // Sparse drafting grid behind the product.
    let grid=abs(fract(p/32.+0.5)-0.5)*32.;
    color+=vec3(0.017)*max(coverage(grid.x-0.3,aa),coverage(grid.y-0.3,aa))*0.35;
    let shadow=body(p-vec2(0.,15.));
    color=mix(color,vec3(0.015,0.023,0.034),0.65*exp(-max(shadow,0.)/18.));
    let d=body(p);
    let grad=vec2(body(p+vec2(1.,0.))-body(p-vec2(1.,0.)),body(p+vec2(0.,1.))-body(p-vec2(0.,1.)));
    let bevel=exp(-abs(d+3.)/5.);
    let lighting=dot(normalize(vec3(grad*bevel,2.)),normalize(vec3(-0.6,-0.9,1.)));
    let noise=fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);
    var shell=vec3(0.19,0.215,0.25)*(0.7+0.38*lighting)+noise*0.008;
    shell+=vec3(0.07)*exp(-abs(d+1.7)/1.3);
    shell-=vec3(0.065)*exp(-abs(d+8.)/1.8);
    color=mix(color,shell,coverage(d,aa));
    // Recessed control wells and concentric analog-stick seats.
    for(var i=0u;i<4u;i++) {
        let centers=array<vec2<f32>,4>(vec2(270.,260.),vec2(730.,260.),vec2(385.,365.),vec2(615.,365.));
        let radius=select(78.,56.,i>=2u);
        let well=length(p-centers[i])-radius;
        color=mix(color,vec3(0.078,0.09,0.11),coverage(well,aa));
        color+=vec3(0.035)*exp(-abs(well)/1.3);
    }
    // Center analog indicator, intentionally decorative rather than a device claim.
    color=mix(color,vec3(0.21,0.7,0.68),coverage(box(p-vec2(500.,332.),vec2(12.,2.),2.),aa));
    for(var i=0u;i<16u;i++) {
        let g=state.geometry[i]; let f=state.flags[i];
        var center=g.xy;
        if(i==12u) { center+=vec2(state.sticks.x,-state.sticks.y)*13.; }
        if(i==13u) { center+=vec2(state.sticks.z,-state.sticks.w)*13.; }
        let q=p-center;
        var bd=box(q,g.zw,5.);
        if(i<4u || i==12u || i==13u) { bd=length(q)-g.z; }
        let palette=array<vec3<f32>,4>(vec3(0.3,0.85,0.69),vec3(0.98,0.44,0.42),vec3(0.42,0.67,1.),vec3(0.91,0.52,0.76));
        let accent=palette[min(i,3u)];
        let ring=select(vec3(0.34,0.76,0.88),accent,i<4u);
        color=mix(color,ring*0.5,coverage(bd-5.,aa)*max(f.y,f.z*0.5));
        var cap=vec3(0.10,0.12,0.15)+vec3(0.025)*clamp(-q.y/g.w,-1.,1.);
        cap=mix(cap,ring*0.50,f.x);
        cap*=mix(0.55,1.,f.w);
        color=mix(color,cap,coverage(bd,aa));
        color+=vec3(0.04)*exp(-abs(bd+1.)/0.8)*coverage(bd,aa);
        var symbol=100.;
        if(i==0u) { symbol=min(min(line(q,vec2(0.,-11.),vec2(-11.,9.)),line(q,vec2(-11.,9.),vec2(11.,9.))),line(q,vec2(11.,9.),vec2(0.,-11.))); }
        if(i==1u) { symbol=abs(length(q)-10.)-1.7; }
        if(i==2u) { symbol=min(line(q,vec2(-8.,-8.),vec2(8.,8.)),line(q,vec2(8.,-8.),vec2(-8.,8.))); }
        if(i==3u) { symbol=abs(box(q,vec2(9.),0.))-1.5; }
        if(i>=4u && i<=7u) {
            var a=q;
            if(i==5u) { a=-q; }
            if(i==6u) { a=vec2(-q.y,q.x); }
            if(i==7u) { a=vec2(q.y,-q.x); }
            symbol=min(line(a,vec2(-6.,3.),vec2(0.,-4.)),line(a,vec2(0.,-4.),vec2(6.,3.)));
        }
        if(i==14u) { symbol=min(min(line(q,vec2(-4.,-5.),vec2(6.,0.)),line(q,vec2(6.,0.),vec2(-4.,5.))),line(q,vec2(-4.,5.),vec2(-4.,-5.))); }
        if(i==15u) { symbol=box(q,vec2(7.,3.),0.); }
        let ink=select(vec3(0.5,0.55,0.63),accent,i<4u)*mix(0.5,1.,f.w);
        color=mix(color,ink,coverage(symbol,aa));
        if(i==12u || i==13u) {
            let rings=abs(length(q)-31.)-0.55;
            color=mix(color,vec3(0.19,0.22,0.26),coverage(rings,aa));
            let texture=sin(q.x*2.)*sin(q.y*2.)*0.012;
            color+=vec3(texture)*coverage(length(q)-29.,aa);
        }
    }
    return vec4(color,1.);
}
