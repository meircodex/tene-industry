'use strict';

// Presentation projection of the existing production queue, without drawings.
function dashboardQueue(items) {
  return items.map(({id,order_id,order_num,customer_name,diameter,weight,status,machine})=>
    ({id,order_id,order_num,customer_name,diameter,weight,status,machine}));
}
module.exports={dashboardQueue};
