

(async()=>{
    let passHash = '5111375395821851'
const cyrb53 = function(str, seed = 0) {
    if(str == null) {return 0}
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1>>>16), 2246822507) ^ Math.imul(h2 ^ (h2>>>13), 3266489909);
    h2 = Math.imul(h2 ^ (h2>>>16), 2246822507) ^ Math.imul(h1 ^ (h1>>>13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1>>>0);
};

function setCookie(cname, cvalue, exdays) {
    const d = new Date();
    d.setTime(d.getTime() + (exdays*24*60*60*1000));
    let expires = "expires="+ d.toUTCString();
    document.cookie = cname + "=" + cvalue + ";" + expires + ";path=/";
}

function getCookie(name) {
    var result = document.cookie.match(new RegExp(name + '=([^;]+)'));
    return result[1];
}

function addGridJS() {
    let api = document.createElement('script');
        let scp = document.createElement('script');
        api.src = '/grid/script/clockapi.js'
        scp.src = '/grid/script/script.js'
        document.body.appendChild(api)
        document.body.appendChild(scp)
}

if(cyrb53((await getCookie('funneeText'))?.value) == passHash) {
   addGridJS();
} else {
    let pass = document.createElement('input');
    let butt = document.createElement('button')
    butt.innerHTML = "enter password"

    butt.onclick = function () {
        if(cyrb53(pass.value) == passHash) {
            setCookie('funneeText',pass.value,200)
            pass.remove();
            butt.remove()
            addGridJS();
        }
    }
    document.body.appendChild(pass)
    document.body.appendChild(butt)
}
})();