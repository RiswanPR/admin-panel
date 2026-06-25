function addToCart(proId) {
    $.ajax({
        url: '/add-to-cart/' + proId,
        method: 'get',
        success: (response) => {
            if (response.status) {
                let count = $('#cart-count').html()
                count = parseInt(count)+1
                location.reload();
                $("#cart-count").html(count)               
            }else{
                location.reload();
            }

        }
    })
}

function changeQuantity(cartId, proId, count) {

    let quantity = parseInt(document.getElementById(proId).innerHTML)
    count = parseInt(count);

    $.ajax({
        url: '/change-product-quantity',
        data: {
            cart: cartId,
            product: proId,
            count: count,
            quantity: quantity,
        },
        method: 'post',
        success: (response) => {
            if (response.removeProduct) {
                alert("Product Removed From Cart");
                location.reload();
            }else{
                document.getElementById(proId).innerHTML=quantity+count
                location.reload();
            }
        }
    })
}

function Delete_Product(cartId, proId, count) {

    let quantity = parseInt(document.getElementById(proId).innerHTML)
    count = parseInt(count);

    $.ajax({
        url: '/Delete-Product',
        data: {
            cart: cartId,
            product: proId,
            count: count,
            quantity: -1,
        },
        method: 'post',
        success: (response) => {
                alert("Product Removed From Cart");
                location.reload();   
        }
    })
}

